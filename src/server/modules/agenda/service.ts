import { z } from "zod";
import type { Appointment, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { addDays, instantToISO, timeInTimezone, todayISO, zonedToInstant, type ISODate } from "@/lib/dates";
import { isoDateSchema as isoDateSchemaLike } from "../transactions/schemas";
import { audit } from "../audit/service";

/**
 * Agenda da família. Compromisso COMPARTILHADO aparece para todos e pode ir para o grupo do WhatsApp
 * (lembrete e resumo da manhã); PRIVADO só para quem é dono — nunca vai para o grupo. Compromissos
 * vindos do Google Agenda são só leitura aqui (edita-se no Google).
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const fields = {
  title: z.string().trim().min(1, "Informe o compromisso").max(160),
  date: isoDateSchemaLike,
  /** "HH:MM"; vazio = dia inteiro. */
  time: z.string().regex(TIME, "Hora inválida (use HH:MM)").nullish(),
  endTime: z.string().regex(TIME, "Hora inválida (use HH:MM)").nullish(),
  location: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  visibility: z.enum(["SHARED", "PRIVATE"]),
  /** Minutos antes para lembrar (null = sem lembrete). */
  reminderMinutes: z.number().int().min(0).max(7 * 24 * 60).nullish(),
};

export const appointmentCreateSchema = z.object({ ...fields, visibility: fields.visibility.default("SHARED"), reminderMinutes: fields.reminderMinutes.default(60) });
export type AppointmentCreateInput = z.input<typeof appointmentCreateSchema>;
export const appointmentUpdateSchema = z.object(fields).partial();
export type AppointmentUpdateInput = z.input<typeof appointmentUpdateSchema>;

export interface AppointmentDTO {
  id: string;
  title: string;
  date: ISODate;
  time: string | null;
  endTime: string | null;
  allDay: boolean;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  notes: string | null;
  visibility: "SHARED" | "PRIVATE";
  owner: { id: string; name: string } | null;
  reminderMinutes: number | null;
  source: "MANUAL" | "WHATSAPP" | "GOOGLE";
  /** Vindo do Google Agenda: edita-se lá. */
  readOnly: boolean;
}

type Row = Appointment & { owner: { id: string; displayName: string } | null };

export function toAppointmentDTO(a: Row, timezone: string): AppointmentDTO {
  return {
    id: a.id,
    title: a.title,
    date: instantToISO(a.startsAt, timezone),
    time: a.allDay ? null : timeInTimezone(a.startsAt, timezone),
    endTime: a.allDay || !a.endsAt ? null : timeInTimezone(a.endsAt, timezone),
    allDay: a.allDay,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt?.toISOString() ?? null,
    location: a.location,
    notes: a.notes,
    visibility: a.visibility === "PRIVATE" ? "PRIVATE" : "SHARED",
    owner: a.owner ? { id: a.owner.id, name: a.owner.displayName } : null,
    reminderMinutes: a.reminderMinutes,
    source: a.source,
    readOnly: a.source === "GOOGLE",
  };
}

/** O que a pessoa pode ver: compartilhados + os próprios privados (sistema: tudo). */
export function visibleAppointmentsWhere(ctx: ServiceContext): Prisma.AppointmentWhereInput {
  const base: Prisma.AppointmentWhereInput = { householdId: ctx.householdId, deletedAt: null };
  if (!ctx.memberId) return base;
  return { ...base, OR: [{ visibility: "SHARED" }, { ownerMemberId: ctx.memberId }] };
}

/** Recorte da família (grupo do WhatsApp, resumo da manhã): só compartilhados. */
export function sharedAppointmentsWhere(householdId: string): Prisma.AppointmentWhereInput {
  return { householdId, deletedAt: null, visibility: "SHARED" };
}

const include = { owner: { select: { id: true, displayName: true } } } as const;

function timesFor(date: ISODate, time: string | null | undefined, endTime: string | null | undefined, timezone: string) {
  const allDay = !time;
  const startsAt = zonedToInstant(date, time ?? "00:00", timezone);
  let endsAt: Date | null = null;
  if (time && endTime) {
    endsAt = zonedToInstant(date, endTime, timezone);
    if (endsAt <= startsAt) throw new ValidationError("O fim precisa ser depois do início.");
  }
  return { allDay, startsAt, endsAt };
}

export const appointmentListSchema = z.object({ start: isoDateSchemaLike.optional(), end: isoDateSchemaLike.optional() });

export async function listAppointments(ctx: ServiceContext, raw: z.input<typeof appointmentListSchema> = {}): Promise<AppointmentDTO[]> {
  assertCan(ctx, "transactions:read");
  const f = appointmentListSchema.parse(raw);
  const start = f.start ?? todayISO(ctx.timezone);
  const end = f.end ?? addDays(start, 30);
  if (end < start) throw new ValidationError("Período inválido.");
  const rows = await prisma.appointment.findMany({
    where: { AND: [visibleAppointmentsWhere(ctx), { startsAt: { gte: zonedToInstant(start, "00:00", ctx.timezone), lt: zonedToInstant(addDays(end, 1), "00:00", ctx.timezone) } }] },
    orderBy: [{ startsAt: "asc" }, { title: "asc" }],
    include,
    take: 500,
  });
  return rows.map((r) => toAppointmentDTO(r, ctx.timezone));
}

async function load(ctx: ServiceContext, id: string) {
  const row = await prisma.appointment.findFirst({ where: { AND: [visibleAppointmentsWhere(ctx), { id }] }, include });
  if (!row) throw new NotFoundError("Compromisso");
  return row;
}

export async function createAppointment(ctx: ServiceContext, raw: AppointmentCreateInput, opts: { source?: "MANUAL" | "WHATSAPP" } = {}): Promise<AppointmentDTO> {
  assertCan(ctx, "transactions:write");
  const data = appointmentCreateSchema.parse(raw);
  if (data.visibility === "PRIVATE" && !ctx.memberId) throw new ValidationError("Compromisso privado precisa de uma pessoa dona.");
  const times = timesFor(data.date, data.time, data.endTime, ctx.timezone);
  const row = await prisma.appointment.create({
    data: {
      householdId: ctx.householdId,
      title: data.title,
      ...times,
      location: data.location ?? null,
      notes: data.notes ?? null,
      visibility: data.visibility,
      ownerMemberId: ctx.memberId,
      reminderMinutes: data.reminderMinutes ?? null,
      source: opts.source ?? "MANUAL",
      createdById: ctx.memberId,
    },
    include,
  });
  await audit(ctx, { action: "CREATE", entityType: "Appointment", entityId: row.id, after: { title: row.title, startsAt: row.startsAt, visibility: row.visibility } });
  await publishEvent(ctx.householdId, "appointment.changed", row.id);
  return toAppointmentDTO(row, ctx.timezone);
}

export async function updateAppointment(ctx: ServiceContext, id: string, raw: AppointmentUpdateInput): Promise<AppointmentDTO> {
  assertCan(ctx, "transactions:write");
  const patch = appointmentUpdateSchema.parse(raw);
  const current = await load(ctx, id);
  if (current.source === "GOOGLE") throw new ValidationError("Este compromisso veio do Google Agenda: altere por lá.");
  if (current.visibility === "PRIVATE" && current.ownerMemberId !== ctx.memberId) throw new NotFoundError("Compromisso");
  if (patch.visibility === "PRIVATE" && current.ownerMemberId !== ctx.memberId) throw new ValidationError("Só quem criou pode tornar o compromisso privado.");
  const dto = toAppointmentDTO(current, ctx.timezone);
  const date = patch.date ?? dto.date;
  const time = patch.time !== undefined ? patch.time : dto.time;
  const endTime = patch.endTime !== undefined ? patch.endTime : patch.time === null ? null : dto.endTime;
  const times = timesFor(date, time, endTime, ctx.timezone);
  const row = await prisma.appointment.update({
    where: { id },
    data: {
      title: patch.title ?? current.title,
      ...times,
      location: patch.location !== undefined ? patch.location ?? null : current.location,
      notes: patch.notes !== undefined ? patch.notes ?? null : current.notes,
      visibility: patch.visibility ?? current.visibility,
      reminderMinutes: patch.reminderMinutes !== undefined ? patch.reminderMinutes ?? null : current.reminderMinutes,
    },
    include,
  });
  await audit(ctx, { action: "UPDATE", entityType: "Appointment", entityId: id, before: { title: current.title, startsAt: current.startsAt }, after: { title: row.title, startsAt: row.startsAt } });
  await publishEvent(ctx.householdId, "appointment.changed", id);
  return toAppointmentDTO(row, ctx.timezone);
}

/** Desmarca (fica no histórico; pode ser restaurado pelo suporte). */
export async function deleteAppointment(ctx: ServiceContext, id: string): Promise<{ id: string; deleted: true }> {
  assertCan(ctx, "transactions:write");
  const current = await load(ctx, id);
  if (current.source === "GOOGLE") throw new ValidationError("Este compromisso veio do Google Agenda: desmarque por lá.");
  await prisma.appointment.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit(ctx, { action: "DELETE", entityType: "Appointment", entityId: id, before: { title: current.title, startsAt: current.startsAt } });
  await publishEvent(ctx.householdId, "appointment.changed", id);
  return { id, deleted: true };
}

/** Compromissos de um dia (recorte da família ou de uma pessoa). */
export async function appointmentsOfDay(householdId: string, timezone: string, date: ISODate, where: Prisma.AppointmentWhereInput) {
  const rows = await prisma.appointment.findMany({
    where: { AND: [where, { startsAt: { gte: zonedToInstant(date, "00:00", timezone), lt: zonedToInstant(addDays(date, 1), "00:00", timezone) } }] },
    orderBy: [{ allDay: "desc" }, { startsAt: "asc" }],
    include,
  });
  return rows.map((r) => toAppointmentDTO(r, timezone));
}

/** "09:00 Dentista (Clínica X)" / "Dia todo: Aniversário da vó". */
export function appointmentLine(a: AppointmentDTO): string {
  const when = a.allDay ? "Dia todo" : a.endTime ? `${a.time}–${a.endTime}` : a.time!;
  return `${when} ${a.title}${a.location ? ` (${a.location})` : ""}`;
}

import type { ServiceContext } from "../../auth/context";
import { can } from "../../auth/permissions";
import { prisma } from "../../db";
import { addDays, formatDateBR, todayISO, timeInTimezone, weekday, type ISODate } from "@/lib/dates";
import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { appointmentLine, appointmentsOfDay, createAppointment, deleteAppointment, sharedAppointmentsWhere } from "../../modules/agenda/service";
import { extractAmounts } from "../nlu/numbers";
import type { ActionOutcome } from "./actions";

/**
 * Agenda pelo WhatsApp, sem IA:
 * - "marca dentista amanhã às 15h", "agendar reunião da escola dia 25 às 19:30", "lembrete pagar
 *   o IPVA sexta" → compromisso COMPARTILHADO (veio do grupo da família);
 * - "agenda de hoje", "o que tenho amanhã?", "agenda da semana" → lista os compartilhados;
 * - "desmarcar dentista" → desmarca o próximo compromisso com esse nome.
 * Compromissos privados nunca aparecem no grupo.
 */

export type AgendaCommand =
  | { kind: "CREATE"; title: string; date: ISODate; time: string | null }
  | { kind: "LIST"; start: ISODate; days: number; label: string }
  | { kind: "DELETE"; title: string };

const WEEKDAY_NAMES: Array<[RegExp, number]> = [
  [/\bdomingo\b/, 0],
  [/\bsegunda(-feira| feira)?\b/, 1],
  [/\bterca(-feira| feira)?\b/, 2],
  [/\bquarta(-feira| feira)?\b/, 3],
  [/\bquinta(-feira| feira)?\b/, 4],
  [/\bsexta(-feira| feira)?\b/, 5],
  [/\bsabado\b/, 6],
];

const CREATE = /^(?:me lembra(?:r)? de|lembra(?:r)? de|lembrete(?: de| para| pra)?|anota(?:r)? na agenda|marca(?:r)?|marque|agenda(?:r)?|agende|compromisso)\b\s*/;
const LIST = /^(?:qual (?:e )?a |minha |a |ver (?:a )?)?agenda(?: (?:de|do|da|pra|para))? ?(hoje|amanha|semana|essa semana|esta semana)?\s*\??$|^(?:o que|oq|que) (?:eu )?tenho (?:pra |para )?(hoje|amanha|essa semana|esta semana|na semana)\s*\??$|^compromissos (?:de |da |do )?(hoje|amanha|semana|essa semana|esta semana)\s*\??$/;
const DELETE = /^(?:desmarca(?:r)?|desmarque|cancela(?:r)? (?:o |a )?(?:compromisso|consulta|reuniao)(?: de| da| do)?)\s+(.+)$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Data dita na frase (relativa a hoje). Devolve a data e o trecho para tirar do título. */
export function extractAgendaDate(norm: string, today: ISODate): { date: ISODate; match: string } | null {
  let m = /\bdepois de amanha\b/.exec(norm);
  if (m) return { date: addDays(today, 2), match: m[0] };
  m = /\bamanha\b/.exec(norm);
  if (m) return { date: addDays(today, 1), match: m[0] };
  m = /\bhoje\b/.exec(norm);
  if (m) return { date: today, match: m[0] };
  m = /\b(?:dia )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(norm);
  if (m) {
    const ty = Number(today.slice(0, 4));
    let y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : ty;
    let iso = `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
    if (!m[3] && iso < today) iso = `${++y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
    const t = Date.parse(`${iso}T12:00:00Z`);
    if (!Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso) return { date: iso, match: m[0] };
  }
  m = /\bdia (\d{1,2})\b/.exec(norm);
  if (m) {
    const day = Number(m[1]);
    const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    for (let i = 0; i < 3; i++) {
      const y = ty + Math.floor((tm - 1 + i) / 12);
      const mo = ((tm - 1 + i) % 12) + 1;
      const iso = `${y}-${pad(mo)}-${pad(day)}`;
      const t = Date.parse(`${iso}T12:00:00Z`);
      if (!Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso && iso >= today) return { date: iso, match: m[0] };
    }
  }
  for (const [re, wd] of WEEKDAY_NAMES) {
    const w = re.exec(norm);
    if (w) {
      const diff = (wd - weekday(today) + 7) % 7 || 7;
      const prefix = new RegExp(`\\b(?:na |no |nesta |neste |nessa |nesse |proxima |proximo )?${w[0].replace(/[-]/g, "\\-")}`).exec(norm);
      return { date: addDays(today, diff), match: prefix?.[0] ?? w[0] };
    }
  }
  return null;
}

/** Hora dita na frase ("às 15h", "15:30", "3 da tarde", "meio dia"). */
export function extractAgendaTime(norm: string): { time: string; match: string } | null {
  let m = /\b(?:as |a )?meio[ -]dia(?: e meia)?\b/.exec(norm);
  if (m) return { time: m[0].includes("meia") ? "12:30" : "12:00", match: m[0] };
  m = /\b(?:as |a )?(\d{1,2})(?::|h)(\d{2})\b/.exec(norm);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { time: `${pad(Number(m[1]))}:${m[2]}`, match: m[0] };
  m = /\b(?:as |a )?(\d{1,2}) ?(?:h|hs|horas?)\b(?: e meia)?/.exec(norm);
  if (m && Number(m[1]) < 24) return { time: `${pad(Number(m[1]))}:${m[0].includes("meia") ? "30" : "00"}`, match: m[0] };
  m = /\b(?:as |a )(\d{1,2})(?: e meia)?(?: da (manha|tarde|noite))?\b/.exec(norm) ?? /\b(\d{1,2})(?: e meia)? da (manha|tarde|noite)\b/.exec(norm);
  if (m) {
    let h = Number(m[1]);
    const period = m[2];
    if (h > 23) return null;
    if ((period === "tarde" || period === "noite") && h < 12) h += 12;
    return { time: `${pad(h)}:${m[0].includes("meia") ? "30" : "00"}`, match: m[0] };
  }
  return null;
}

function cleanTitle(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:o|a|os|as|um|uma|de|do|da|pra|para|com|no|na|que)\s+)+/i, "")
    .replace(/(?:\s+(?:de|do|da|pra|para|no|na|em|e|,))+$/i, "")
    .replace(/[,.;!?]+$/, "")
    .trim();
}

/** Remove um trecho já normalizado do texto original (mesmo tamanho: a normalização só troca acentos). */
function cut(original: string, norm: string, piece: string): { original: string; norm: string } {
  const at = norm.indexOf(piece);
  if (at < 0) return { original, norm };
  return { original: `${original.slice(0, at)} ${original.slice(at + piece.length)}`, norm: `${norm.slice(0, at)} ${norm.slice(at + piece.length)}` };
}

export function parseAgendaCommand(text: string, today: ISODate): AgendaCommand | null {
  const original = text.normalize("NFC").trim().replace(/\s+/g, " ");
  if (original.length > 200) return null;
  // Normalização que preserva posições: minúsculas e sem acento (cada letra continua no lugar).
  const norm = original.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (norm.length !== original.length) return null;
  const plain = norm.replace(/[?!.]+$/, "").trim();

  const list = LIST.exec(plain);
  if (list) {
    const which = list[1] ?? list[2] ?? list[3] ?? "hoje";
    if (which.includes("semana")) return { kind: "LIST", start: today, days: 7, label: "dos próximos 7 dias" };
    if (which === "amanha") return { kind: "LIST", start: addDays(today, 1), days: 1, label: "de amanhã" };
    return { kind: "LIST", start: today, days: 1, label: "de hoje" };
  }

  const del = DELETE.exec(plain);
  if (del) {
    const title = cleanTitle(original.slice(original.length - del[1]!.length));
    return title ? { kind: "DELETE", title } : null;
  }

  const create = CREATE.exec(norm);
  if (!create) return null;
  // Valor em dinheiro na frase: é lançamento ("marca 50 no mercado"), não compromisso.
  if (extractAmounts(original).some((a) => a.hasCurrency)) return null;
  let o = original.slice(create[0].length);
  let n = norm.slice(create[0].length);
  const date = extractAgendaDate(n, today);
  if (date) ({ original: o, norm: n } = cut(o, n, date.match));
  const time = extractAgendaTime(n);
  if (time) ({ original: o, norm: n } = cut(o, n, time.match));
  if (!date && !time) return null;
  const title = cleanTitle(o);
  if (!title || title.length < 2) return null;
  return { kind: "CREATE", title: title.charAt(0).toUpperCase() + title.slice(1), date: date?.date ?? today, time: time?.time ?? null };
}

const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const dayLabel = (iso: ISODate) => `${DOW[weekday(iso)]}, ${formatDateBR(iso).slice(0, 5)}`;

export async function handleAgendaCommand(ctx: ServiceContext, cmd: AgendaCommand): Promise<ActionOutcome> {
  const today = todayISO(ctx.timezone);
  if (cmd.kind === "LIST") {
    const days: string[] = [];
    for (let i = 0; i < cmd.days; i++) {
      const d = addDays(cmd.start, i);
      const items = await appointmentsOfDay(ctx.householdId, ctx.timezone, d, sharedAppointmentsWhere(ctx.householdId));
      if (items.length) days.push(`${cmd.days > 1 ? `*${dayLabel(d)}*\n` : ""}${items.map((a) => `• ${appointmentLine(a)}`).join("\n")}`);
    }
    const reply = days.length ? `📅 Agenda ${cmd.label}:\n${days.join("\n")}` : `📅 Nada na agenda ${cmd.label}.`;
    return { status: "PROCESSED", intent: "AGENDA_LIST", replies: [reply], transactionIds: [] };
  }
  if (!can(ctx.role, "transactions:write")) {
    return { status: "IGNORED", intent: "AGENDA", replies: ["Seu perfil não pode alterar a agenda."], transactionIds: [] };
  }
  if (cmd.kind === "DELETE") {
    const upcoming = await prisma.appointment.findMany({
      where: { ...sharedAppointmentsWhere(ctx.householdId), source: { not: "GOOGLE" }, startsAt: { gte: new Date(Date.now() - 3_600_000) } },
      orderBy: { startsAt: "asc" },
      take: 200,
    });
    const target = normalizeText(cmd.title);
    const hits = upcoming.filter((a) => normalizeText(a.title).includes(target) || tokenSimilarity(a.title, cmd.title) >= 0.6);
    if (!hits.length) return { status: "PROCESSED", intent: "AGENDA_DELETE", replies: [`📅 Não achei compromisso "${cmd.title}" na agenda.`], transactionIds: [] };
    const first = hits[0]!;
    // Vários com o mesmo nome: desmarca o próximo e avisa.
    await deleteAppointment(ctx, first.id);
    const when = `${dayLabel(todayISO(ctx.timezone, first.startsAt))}${first.allDay ? "" : ` às ${timeInTimezone(first.startsAt, ctx.timezone)}`}`;
    const more = hits.length > 1 ? ` Ainda há ${hits.length - 1} outro(s) com esse nome.` : "";
    return { status: "PROCESSED", intent: "AGENDA_DELETE", replies: [`📅 Desmarquei *${first.title}* (${when}).${more}`], transactionIds: [] };
  }
  if (cmd.date < today) return { status: "PROCESSED", intent: "AGENDA_CREATE", replies: ["📅 Essa data já passou. Mande a data de novo."], transactionIds: [] };
  const appt = await createAppointment(ctx, { title: cmd.title, date: cmd.date, time: cmd.time, visibility: "SHARED", reminderMinutes: cmd.time ? 60 : null }, { source: "WHATSAPP" });
  const when = `${dayLabel(appt.date)}${appt.time ? ` às ${appt.time}` : " (dia todo)"}`;
  const reminder = appt.time ? " Aviso 1 hora antes." : " Entra no resumo da manhã.";
  return {
    status: "PROCESSED",
    intent: "AGENDA_CREATE",
    replies: [`📅 Marquei: *${appt.title}* — ${when}.${reminder} Para desmarcar: *desmarcar ${appt.title.toLowerCase()}*`],
    transactionIds: [],
    detail: `compromisso ${appt.id}`,
  };
}

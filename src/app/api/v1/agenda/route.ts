import { authed } from "@/server/api/handler";
import { appointmentCreateSchema, appointmentListSchema, createAppointment, listAppointments } from "@/server/modules/agenda/service";

/** GET ?start&end (AAAA-MM-DD; padrão: hoje + 30 dias) → compromissos compartilhados + os seus privados. */
export const GET = authed({ query: appointmentListSchema }, async ({ ctx, query }) => listAppointments(ctx, query));

/** POST { title, date, time?, endTime?, location?, notes?, visibility?, reminderMinutes? } */
export const POST = authed({ body: appointmentCreateSchema, permission: "transactions:write" }, async ({ ctx, body }) => createAppointment(ctx, body));

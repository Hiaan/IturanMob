import { authed } from "@/server/api/handler";
import { appointmentUpdateSchema, deleteAppointment, updateAppointment } from "@/server/modules/agenda/service";

export const PATCH = authed({ body: appointmentUpdateSchema, permission: "transactions:write" }, async ({ ctx, params, body }) => updateAppointment(ctx, params.id!, body));

/** DELETE → desmarca o compromisso. */
export const DELETE = authed({ permission: "transactions:write" }, async ({ ctx, params }) => deleteAppointment(ctx, params.id!));

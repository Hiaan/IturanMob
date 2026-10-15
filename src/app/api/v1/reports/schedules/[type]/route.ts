import { authed } from "@/server/api/handler";
import { ValidationError } from "@/server/errors";
import { scheduleUpdateSchema, updateReportSchedule } from "@/server/modules/reports/service";

/** Atualiza o agendamento (WEEKLY | MONTHLY): { enabled?, dayOfWeek?, dayOfMonth?, hour?, sendWhatsApp?, notifyInApp? }. */
export const PATCH = authed({ body: scheduleUpdateSchema, permission: "settings:manage" }, async ({ ctx, params, body }) => {
  const type = (params.type ?? "").toUpperCase();
  if (type !== "WEEKLY" && type !== "MONTHLY") throw new ValidationError("Tipo de relatório inválido (use WEEKLY ou MONTHLY).");
  return updateReportSchedule(ctx, type, body);
});

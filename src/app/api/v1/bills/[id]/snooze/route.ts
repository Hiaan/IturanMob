import { authed } from "@/server/api/handler";
import { billSnoozeSchema, snoozeBillReminder } from "@/server/modules/bills/service";

/** POST { days? } → "pagar depois": adia o lembrete de conta vencida (padrão 3 dias). */
export const POST = authed({ body: billSnoozeSchema, permission: "bills:write" }, async ({ ctx, params, body }) => snoozeBillReminder(ctx, params.id!, body));

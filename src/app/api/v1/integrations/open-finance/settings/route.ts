import { authed } from "@/server/api/handler";
import { openFinanceSettingsSchema, updateOpenFinanceSettings } from "@/server/modules/open-finance/service";

/** PATCH { autoImport?, initialDays? } */
export const PATCH = authed({ body: openFinanceSettingsSchema, permission: "integrations:manage" }, async ({ ctx, body }) => updateOpenFinanceSettings(ctx, body));

import { authed } from "@/server/api/handler";
import { getHousehold, settingsUpdateSchema, updateSettings } from "@/server/modules/households/service";

export const GET = authed({}, async ({ ctx }) => (await getHousehold(ctx)).settings);
export const PATCH = authed({ body: settingsUpdateSchema }, async ({ ctx, body }) => updateSettings(ctx, body));

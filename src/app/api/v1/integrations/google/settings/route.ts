import { authed } from "@/server/api/handler";
import { googleSettingsSchema, updateGoogleSettings } from "@/server/modules/agenda/google";

/** PATCH { shareWithFamily } */
export const PATCH = authed({ body: googleSettingsSchema }, async ({ ctx, body }) => updateGoogleSettings(ctx, body));

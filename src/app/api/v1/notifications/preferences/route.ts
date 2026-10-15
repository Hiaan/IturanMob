import { authed } from "@/server/api/handler";
import { getPreferences, preferencesUpdateSchema, updatePreferences } from "@/server/modules/notifications/service";

/** GET → preferências do membro logado, uma por tipo de notificação. */
export const GET = authed({}, async ({ ctx }) => getPreferences(ctx));

/** PUT { items: [{ type, inApp?, whatsapp?, email?, frequency?, quietStart?, quietEnd? }] } */
export const PUT = authed({ body: preferencesUpdateSchema }, async ({ ctx, body }) => updatePreferences(ctx, body.items));

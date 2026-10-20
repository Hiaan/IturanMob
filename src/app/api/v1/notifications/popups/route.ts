import { authed } from "@/server/api/handler";
import { getPopupPreference, popupPreferenceSchema, setPopupPreference } from "@/server/modules/notifications/service";

/** GET → { inAppPopups } do membro logado ("Mostrar pop-ups no app"). */
export const GET = authed({}, async ({ ctx }) => getPopupPreference(ctx));

/** PUT { inAppPopups } */
export const PUT = authed({ body: popupPreferenceSchema }, async ({ ctx, body }) => setPopupPreference(ctx, body));

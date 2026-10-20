import { authed } from "@/server/api/handler";
import { startGoogleConnect } from "@/server/modules/agenda/google";

/** POST → { url } do consentimento do Google (somente leitura da agenda). */
export const POST = authed({ rateLimit: { key: "google:connect", limit: 10, windowSeconds: 600 } }, async ({ ctx }) => startGoogleConnect(ctx));

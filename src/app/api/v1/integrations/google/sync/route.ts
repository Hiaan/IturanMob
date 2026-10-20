import { authed } from "@/server/api/handler";
import { syncMyGoogle } from "@/server/modules/agenda/google";

/** POST → atualiza agora a sua agenda do Google. */
export const POST = authed({ rateLimit: { key: "google:sync", limit: 10, windowSeconds: 600 } }, async ({ ctx }) => syncMyGoogle(ctx));

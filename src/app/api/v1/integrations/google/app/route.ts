import { authed } from "@/server/api/handler";
import { googleAppSchema, saveGoogleApp } from "@/server/modules/agenda/google";

/** PUT { clientId, clientSecret? } → aplicação OAuth da família (cifrada). */
export const PUT = authed({ body: googleAppSchema, permission: "integrations:manage" }, async ({ ctx, body }) => saveGoogleApp(ctx, body));

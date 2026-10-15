import { authed } from "@/server/api/handler";
import { groupAuthorizationSchema, setGroupAuthorization } from "@/server/whatsapp/service";

/** Autoriza/revoga o grupo (no máximo um grupo autorizado por família). */
export const PATCH = authed({ body: groupAuthorizationSchema, permission: "integrations:manage" }, async ({ ctx, params, body }) =>
  setGroupAuthorization(ctx, params.id!, body.authorized),
);

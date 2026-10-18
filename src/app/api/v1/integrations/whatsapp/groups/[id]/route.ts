import { authed } from "@/server/api/handler";
import { groupAuthorizationSchema, updateGroup } from "@/server/whatsapp/service";

/** Autoriza/revoga o grupo e/ou define a natureza padrão ({ authorized?, defaultNature? }). Vários grupos podem ser autorizados. */
export const PATCH = authed({ body: groupAuthorizationSchema, permission: "integrations:manage" }, async ({ ctx, params, body }) => updateGroup(ctx, params.id!, body));

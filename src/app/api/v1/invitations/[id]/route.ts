import { authed } from "@/server/api/handler";
import { revokeInvitation } from "@/server/modules/households/service";

export const DELETE = authed({ permission: "members:manage" }, async ({ ctx, params }) => {
  await revokeInvitation(ctx, params.id!);
  return { ok: true };
});

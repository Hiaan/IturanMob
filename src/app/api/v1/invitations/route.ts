import { authed } from "@/server/api/handler";
import { createInvitation, inviteSchema, listInvitations } from "@/server/modules/households/service";

export const GET = authed({ permission: "members:manage" }, async ({ ctx }) => listInvitations(ctx));
export const POST = authed({ body: inviteSchema, permission: "members:manage" }, async ({ ctx, body }) => {
  const { invitation, url } = await createInvitation(ctx, body);
  return { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt, url };
});

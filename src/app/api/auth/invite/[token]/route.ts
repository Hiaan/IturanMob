import { publicRoute } from "@/server/api/handler";
import { getInvitationByToken } from "@/server/modules/households/service";
import { NotFoundError } from "@/server/errors";

export const GET = publicRoute({ rateLimit: { key: "invite-view", limit: 30, windowSeconds: 600 } }, async ({ params }) => {
  const inv = await getInvitationByToken(params.token ?? "");
  if (!inv) throw new NotFoundError("Convite");
  return { email: inv.email, householdName: inv.household.name, role: inv.role, expiresAt: inv.expiresAt };
});

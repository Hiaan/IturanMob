import { authed } from "@/server/api/handler";
import { revokeHouseholdInvite } from "@/server/modules/instance/invites";

export const DELETE = authed({}, async ({ ctx, params }) => revokeHouseholdInvite(ctx, params.id!));

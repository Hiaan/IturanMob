import { authed } from "@/server/api/handler";
import { permissionsFor } from "@/server/auth/permissions";
import { pendingCounts } from "@/server/modules/pending/service";

export const GET = authed({}, async ({ session, ctx }) => ({
  user: session.user,
  member: session.member,
  household: session.household,
  permissions: permissionsFor(ctx.role),
  canViewOthersPrivate: ctx.canViewOthersPrivate,
  pending: await pendingCounts(ctx),
}));

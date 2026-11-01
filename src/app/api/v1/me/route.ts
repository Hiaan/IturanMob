import { authed } from "@/server/api/handler";
import { permissionsFor } from "@/server/auth/permissions";
import { isInstanceAdmin } from "@/server/modules/instance/invites";
import { pendingCounts } from "@/server/modules/pending/service";

export const GET = authed({}, async ({ session, ctx }) => ({
  user: session.user,
  member: session.member,
  household: session.household,
  permissions: permissionsFor(ctx.role),
  canViewOthersPrivate: ctx.canViewOthersPrivate,
  pending: await pendingCounts(ctx),
  /** Administrador da instalação: vê o painel "Administração". */
  instanceAdmin: await isInstanceAdmin(ctx.userId),
}));

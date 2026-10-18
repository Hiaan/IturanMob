import { authed } from "@/server/api/handler";
import { createHouseholdInvite, householdInviteSchema, listHouseholdInvites } from "@/server/modules/instance/invites";

/** Convites de nova família (só o administrador da instância vê e gera). */
export const GET = authed({}, async ({ ctx }) => listHouseholdInvites(ctx));
export const POST = authed({ body: householdInviteSchema, rateLimit: { key: "household-invite", limit: 20, windowSeconds: 3600 } }, async ({ ctx, body }) => createHouseholdInvite(ctx, body));

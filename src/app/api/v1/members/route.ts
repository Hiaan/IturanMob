import { authed } from "@/server/api/handler";
import { createDependentMember, listMembers, memberCreateSchema } from "@/server/modules/households/service";

export const GET = authed({}, async ({ ctx }) => listMembers(ctx));
export const POST = authed({ body: memberCreateSchema }, async ({ ctx, body }) => createDependentMember(ctx, body));

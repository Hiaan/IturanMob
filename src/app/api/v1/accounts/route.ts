import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { accountSchema, createAccount, listAccounts } from "@/server/modules/accounts/service";

export const GET = authed({ query: z.object({ includeArchived: qs.bool() }) }, async ({ ctx, query }) =>
  listAccounts(ctx, { includeArchived: query.includeArchived }),
);
export const POST = authed({ body: accountSchema, permission: "accounts:write" }, async ({ ctx, body }) => createAccount(ctx, body));

import { authed } from "@/server/api/handler";
import { accountUpdateSchema, deleteAccount, getAccount, updateAccount } from "@/server/modules/accounts/service";

export const GET = authed({}, async ({ ctx, params }) => getAccount(ctx, params.id!));
export const PATCH = authed({ body: accountUpdateSchema, permission: "accounts:write" }, async ({ ctx, params, body }) => updateAccount(ctx, params.id!, body));
export const DELETE = authed({ permission: "accounts:write" }, async ({ ctx, params }) => {
  await deleteAccount(ctx, params.id!);
  return { ok: true };
});

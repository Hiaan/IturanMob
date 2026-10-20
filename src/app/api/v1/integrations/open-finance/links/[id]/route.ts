import { authed } from "@/server/api/handler";
import { updateBankLink, updateBankLinkSchema } from "@/server/modules/open-finance/service";

/** PATCH { accountId?, creditCardId?, enabled? } → liga a conta/cartão do banco à conta/cartão do app. */
export const PATCH = authed({ body: updateBankLinkSchema, permission: "integrations:manage" }, async ({ ctx, params, body }) => updateBankLink(ctx, params.id!, body));

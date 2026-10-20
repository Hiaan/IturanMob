import { authed } from "@/server/api/handler";
import { addBankItem, addBankItemSchema } from "@/server/modules/open-finance/service";

/** POST { itemId } → conecta um banco já ligado no Meu Pluggy (ID da conexão). */
export const POST = authed(
  { body: addBankItemSchema, permission: "integrations:manage", rateLimit: { key: "open-finance:items", limit: 20, windowSeconds: 600 } },
  async ({ ctx, body }) => addBankItem(ctx, body),
);

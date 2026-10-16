import { authed } from "@/server/api/handler";
import { getAccountYield, refreshAccountYield } from "@/server/modules/investments/service";

/** Rendimento automático da conta: meses apurados, bruto e estimativa líquida (IR/IOF). */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx, params }) => getAccountYield(ctx, params.id!));

/** "Atualizar agora": busca as taxas no Banco Central e reapura o rendimento da conta. */
export const POST = authed({ permission: "accounts:write", rateLimit: { key: "accounts:yield-refresh", limit: 10, windowSeconds: 60 } }, async ({ ctx, params }) =>
  refreshAccountYield(ctx, params.id!),
);

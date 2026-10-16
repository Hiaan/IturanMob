import { prisma } from "@/server/db";
import { authed } from "@/server/api/handler";
import { NotFoundError } from "@/server/errors";
import { getAccount } from "@/server/modules/accounts/service";
import { fxVariation } from "@/server/modules/fx/service";

/**
 * Conta em moeda estrangeira: valor em reais hoje, custo em reais dos movimentos e a variação
 * cambial (só pela cotação — não é receita nem despesa). Conta em reais → null.
 */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx, params }) => {
  const dto = await getAccount(ctx, params.id!);
  const account = await prisma.account.findFirst({ where: { id: dto.id, householdId: ctx.householdId }, select: { id: true, currency: true, initialBalanceCents: true, initialBalanceDate: true } });
  if (!account) throw new NotFoundError("Conta");
  return { currency: account.currency, balanceCents: dto.balanceCents, variation: await fxVariation(account, dto.balanceCents) };
});

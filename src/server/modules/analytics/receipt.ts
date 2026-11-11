import type { ServiceContext } from "../../auth/context";
import { monthRange } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { budgetOverview, recognizedRows, resolveRegime } from "./service";

/**
 * "Recibo" de um gasto: quanto a categoria já soma no mês e, se houver orçamento, quanto resta.
 * Ex.: "Alimentação no mês: R$ 412,00 de R$ 800,00 (52%), restam R$ 388,00".
 * Nunca impede o registro: em erro, devolve null.
 */
export async function categoryMonthLine(ctx: ServiceContext, categoryId: string, label: string, date: string): Promise<string | null> {
  try {
    const month = date.slice(0, 7);
    const regime = await resolveRegime(ctx);
    const rows = await recognizedRows(ctx, monthRange(month), regime, { categoryIds: [categoryId] });
    const spent = rows.filter((r) => r.type === "EXPENSE").reduce((acc, r) => acc + r.amountCents, 0);
    const name = label.split(" › ")[0] || "Categoria";
    const budget = (await budgetOverview(ctx, month, regime)).items.find((b) => b.category.id === categoryId);
    if (!budget || budget.limitCents <= 0) return `${name} no mês: ${formatBRL(spent)}`;
    const pct = Math.round(budget.percentUsed);
    return budget.remainingCents >= 0
      ? `${name} no mês: ${formatBRL(budget.spentCents)} de ${formatBRL(budget.limitCents)} (${pct}%), restam ${formatBRL(budget.remainingCents)}`
      : `${name} no mês: ${formatBRL(budget.spentCents)}, passou ${formatBRL(-budget.remainingCents)} do orçamento de ${formatBRL(budget.limitCents)}`;
  } catch {
    return null;
  }
}

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { adjustBalance, createAccount, getAccount, updateAccount } from "@/server/modules/accounts/service";
import { createTransaction, deleteTransaction } from "@/server/modules/transactions/service";
import { getAccountYield, refreshNeededRates, runYieldAccrual } from "@/server/modules/investments/service";
import { createFamily, resetDatabase } from "./helpers";

/**
 * Rendimento automático: taxas do Banco Central (simulado aqui; em produção, a API pública SGS),
 * apuração mensal idempotente, recálculo com aplicações no meio, exclusão respeitada e BCB fora.
 */

const NOW = new Date("2026-10-16T12:00:00Z");
const CDI_DAY = "0.055131";

/** SGS falso: devolve dias úteis (seg–sex) do período pedido, como a API real. */
function fakeBcb(calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    const toIso = (s: string) => `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
    const from = new Date(`${toIso(q.get("dataInicial")!)}T00:00:00Z`);
    const to = new Date(`${toIso(q.get("dataFinal")!)}T00:00:00Z`);
    const rows: Array<{ data: string; valor: string }> = [];
    for (let d = from; d <= to; d = new Date(d.getTime() + 86_400_000)) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const iso = d.toISOString().slice(0, 10);
      rows.push({ data: `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, valor: url.includes("sgs.433") ? "0.44" : CDI_DAY });
    }
    return { ok: true, status: 200, json: async () => rows };
  };
}

async function setup() {
  const fam = await createFamily();
  const checking = await createAccount(fam.ctx, { name: "C6", institution: "C6 Bank", type: "CHECKING", initialBalanceCents: 500_000, initialBalanceDate: "2026-08-01" });
  const cdb = await createAccount(fam.ctx, {
    name: "CDB C6",
    institution: "C6 Bank",
    type: "INVESTMENT",
    initialBalanceCents: 1_000_000,
    initialBalanceDate: "2026-08-31",
    yieldIndex: "CDI",
    yieldRateBps: 10_150,
    yieldStartDate: "2026-09-01",
  });
  return { fam, checking, cdb };
}

const yields = (householdId: string) => prisma.transaction.findMany({ where: { householdId, source: "SYSTEM", deletedAt: null }, orderBy: { date: "asc" }, include: { category: true, subcategory: true } });

describe("Rendimento automático de investimentos", () => {
  beforeEach(async () => {
    await resetDatabase();
    await prisma.indexRate.deleteMany();
  });

  it("CDI do Banco Central → uma receita por mês em Investimentos › Rendimentos, idempotente", async () => {
    const { fam, cdb } = await setup();
    const calls: string[] = [];
    const rates = await refreshNeededRates({ now: NOW, fetchImpl: fakeBcb(calls) });
    expect(rates.errors).toEqual([]);
    expect(calls[0]).toContain("bcdata.sgs.12/dados?formato=json&dataInicial=01/09/2026&dataFinal=16/10/2026");

    const first = await runYieldAccrual({ now: NOW });
    expect(first).toMatchObject({ accounts: 1, created: 2 });
    const txs = await yields(fam.householdId);
    expect(txs.map((t) => [t.type, t.description, t.category?.name, t.subcategory?.name, t.accountId])).toEqual([
      ["INCOME", "Rendimento CDB C6 — setembro de 2026", "Investimentos", "Rendimentos", cdb.id],
      ["INCOME", "Rendimento CDB C6 — outubro de 2026", "Investimentos", "Rendimentos", cdb.id],
    ]);
    // Setembro/2026: 22 dias úteis (seg–sex) a 101,5% de 0,055131% ao dia, composto.
    const daily = (0.055131 / 100) * 1.015;
    expect(txs[0]!.amountCents).toBe(Math.round(1_000_000 * (Math.pow(1 + daily, 22) - 1)));
    expect(txs[0]!.notes).toContain("101,5% do CDI");

    // Rodar de novo não duplica nem altera.
    const again = await runYieldAccrual({ now: NOW });
    expect(again).toMatchObject({ created: 0, updated: 0, removed: 0 });
    expect(await yields(fam.householdId)).toHaveLength(2);
    // Busca só o que falta (nada novo hoje).
    const calls2: string[] = [];
    await refreshNeededRates({ now: NOW, fetchImpl: fakeBcb(calls2) });
    expect(calls2.length).toBeLessThanOrEqual(1);

    const summary = await getAccountYield(fam.ctx, cdb.id);
    expect(summary).toMatchObject({ configured: true, label: "101,5% do CDI", status: "OK", ratesThrough: "2026-10-16" });
    if (!summary.configured) throw new Error();
    expect(summary.grossCents).toBe(txs[0]!.amountCents + txs[1]!.amountCents);
    expect(summary.estimate.irCents).toBeGreaterThan(0);
    expect(summary.estimate.note).toContain("Estimativa");
  });

  it("aplicação no meio do mês recalcula só o mês afetado; exclusão pelo usuário é respeitada", async () => {
    const { fam, checking, cdb } = await setup();
    await refreshNeededRates({ now: NOW, fetchImpl: fakeBcb() });
    await runYieldAccrual({ now: NOW });
    const [sep, oct] = await yields(fam.householdId);

    await createTransaction(fam.ctx, { type: "TRANSFER", amountCents: 200_000, description: "Aplicação CDB", date: "2026-10-05", accountId: checking.id, destinationAccountId: cdb.id });
    const r = await runYieldAccrual({ now: NOW });
    expect(r).toMatchObject({ created: 0, updated: 1 });
    const after = await yields(fam.householdId);
    expect(after[0]!.amountCents).toBe(sep!.amountCents);
    expect(after[1]!.amountCents).toBeGreaterThan(oct!.amountCents);

    await deleteTransaction(fam.ctx, oct!.id);
    await runYieldAccrual({ now: NOW });
    expect((await yields(fam.householdId)).map((t) => t.id)).toEqual([sep!.id]);
    expect(await prisma.investmentYield.findFirstOrThrow({ where: { accountId: cdb.id, month: "2026-10" } })).toMatchObject({ dismissed: true });
  });

  it("Banco Central fora do ar: registra, não trava e apura com as taxas guardadas", async () => {
    const { fam } = await setup();
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await refreshNeededRates({ now: NOW, fetchImpl: down });
    expect(r.errors[0]).toContain("Banco Central indisponível");
    expect(await runYieldAccrual({ now: NOW })).toMatchObject({ created: 0, waiting: 1 });
    // Volta: a próxima execução busca e lança.
    await refreshNeededRates({ now: NOW, fetchImpl: fakeBcb() });
    expect((await runYieldAccrual({ now: NOW })).created).toBe(2);
    expect(await yields(fam.householdId)).toHaveLength(2);
  });

  it("ajustar ao saldo do banco cria um ajuste com a diferença; configuração só em conta de investimento", async () => {
    const { fam, checking, cdb } = await setup();
    await refreshNeededRates({ now: NOW, fetchImpl: fakeBcb() });
    await runYieldAccrual({ now: NOW });
    const balance = (await getAccount(fam.ctx, cdb.id)).balanceCents;
    const res = await adjustBalance(fam.ctx, cdb.id, { targetBalanceCents: balance + 1234, note: "Ajuste ao saldo do banco" });
    expect(res.adjusted).toBe(true);
    expect((await getAccount(fam.ctx, cdb.id)).balanceCents).toBe(balance + 1234);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "ADJUSTMENT" } })).toBe(1);

    await expect(updateAccount(fam.ctx, checking.id, { yieldIndex: "CDI", yieldRateBps: 10_000, yieldStartDate: "2026-09-01" })).rejects.toThrow(/só para contas de investimento/);
    await expect(updateAccount(fam.ctx, cdb.id, { yieldRateBps: null })).rejects.toThrow(/percentual do indexador/);
    // Mudar o percentual reapura na hora (com as taxas já guardadas).
    const before = (await yields(fam.householdId))[0]!.amountCents;
    await updateAccount(fam.ctx, cdb.id, { yieldRateBps: 12_000 });
    expect((await yields(fam.householdId))[0]!.amountCents).toBeGreaterThan(before);
  });
});

import { describe, expect, it } from "vitest";
import { SimulatedOpenFinanceClient } from "@/server/integrations/open-finance/pluggy";
import { toImportRow } from "@/server/modules/open-finance/service";

describe("Open Finance: simulador e conversão para a importação", () => {
  it("simulador: dados de exemplo identificados e estáveis (o mesmo id volta igual)", async () => {
    const sim = new SimulatedOpenFinanceClient();
    await expect(sim.getItem("abc")).rejects.toThrow(/simulado/);
    expect((await sim.getItem("simulado-0000-banco")).institutionName).toContain("Simulado");
    const [conta] = await sim.listAccounts("simulado-0000-banco");
    const a = await sim.listTransactions(conta!.id, "2026-10-01", "2026-10-20");
    const b = await sim.listTransactions(conta!.id, "2026-10-01", "2026-10-20");
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a.every((t) => t.description.includes("(simulado)"))).toBe(true);
  });

  it("linha da prévia: sinal pelo tipo, data no fuso da família e parcela no cartão", () => {
    const base = { id: "x1", date: "2026-10-20T02:30:00.000Z", description: "Loja", amountCents: 25_000, direction: "OUT" as const, status: "POSTED" as const, currency: "BRL", installment: { number: 2, total: 6 }, merchantName: null };
    expect(toImportRow(base, "America/Recife", true)).toMatchObject({ date: "2026-10-19", amountCents: -25_000, description: "Loja PARC 02/06", externalId: "of:x1" });
    expect(toImportRow({ ...base, description: "Loja PARC 2/6" }, "America/Recife", true).description).toBe("Loja PARC 2/6");
    expect(toImportRow({ ...base, direction: "IN", installment: null }, "America/Recife", false)).toMatchObject({ amountCents: 25_000, description: "Loja" });
  });
});

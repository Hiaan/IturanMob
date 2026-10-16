import { describe, expect, it } from "vitest";
import { computeYield, estimateNet, iofRate, irRate, type RateTables } from "@/server/modules/investments/yield-calc";

const days = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"];
const tables = (rate: number): RateTables => ({ businessDays: days, daily: new Map(days.map((d) => [d, rate])), monthlyIpca: new Map() });

describe("rendimento: cálculo dia útil a dia útil", () => {
  it("100% e 101,5% do CDI compostos sobre o saldo do dia anterior, agrupados por mês", () => {
    const mov = [{ date: "2026-09-01", amountCents: 1_000_000 }];
    const r100 = computeYield({ index: "CDI", rateBps: 10_000, startDate: "2026-09-29" }, mov, tables(0.05), "2026-10-05");
    // 10.000,00 × 0,05% ao dia, composto: setembro 2 dias, outubro 3 dias.
    const exact = (n: number) => 1_000_000 * (Math.pow(1.0005, n) - 1);
    expect(r100.months.map((m) => [m.month, m.businessDays, m.grossCents])).toEqual([
      ["2026-09", 2, Math.round(exact(2))],
      ["2026-10", 3, Math.round(exact(5) - exact(2))],
    ]);
    const r1015 = computeYield({ index: "CDI", rateBps: 10_150, startDate: "2026-09-29" }, mov, tables(0.05), "2026-10-05");
    expect(r1015.months[0]!.grossCents).toBe(Math.round(1_000_000 * (Math.pow(1 + 0.0005 * 1.015, 2) - 1)));
  });

  it("aplicação e resgate no meio contam a partir do dia seguinte; sem taxa publicada, para", () => {
    const mov = [
      { date: "2026-09-01", amountCents: 1_000_000 },
      { date: "2026-10-01", amountCents: 500_000 }, // aplicação em 01/10: rende a partir de 02/10
      { date: "2026-10-02", amountCents: -1_500_000 }, // resgate total em 02/10: 05/10 rende só o resíduo
    ];
    const t = tables(0.05);
    t.daily.delete("2026-10-05");
    const r = computeYield({ index: "CDI", rateBps: 10_000, startDate: "2026-09-29" }, mov, t, "2026-10-05");
    expect(r.lastAccrued).toBe("2026-10-02");
    const oct = r.months.find((m) => m.month === "2026-10")!;
    expect(oct.businessDays).toBe(2);
    const b1 = 1_000_000 * Math.pow(1.0005, 2);
    const day1 = b1 * 0.0005;
    const day2 = (b1 + day1 + 500_000) * 0.0005;
    expect(oct.grossCents).toBe(Math.round(day1 + day2));
  });

  it("prefixado e IPCA+ (só com IPCA publicado)", () => {
    const mov = [{ date: "2026-09-01", amountCents: 1_000_000 }];
    const pre = computeYield({ index: "PREFIXED", rateBps: 1200, startDate: "2026-09-29" }, mov, tables(0.05), "2026-10-05");
    expect(pre.months.reduce((s, m) => s + m.businessDays, 0)).toBe(5);
    expect(Math.round(pre.balanceExact)).toBe(Math.round(1_000_000 * Math.pow(1.12, 5 / 252)));
    const ipcaTables = { ...tables(0.05), monthlyIpca: new Map([["2026-09", 0.44]]) };
    const ipca = computeYield({ index: "IPCA", rateBps: 600, startDate: "2026-09-29" }, mov, ipcaTables, "2026-10-05");
    expect(ipca.months.map((m) => m.month)).toEqual(["2026-09"]);
    expect(ipca.waitingIpca).toEqual(["2026-10"]);
  });

  it("estimativa líquida: IR regressivo, IOF nos 30 primeiros dias, isenção", () => {
    expect([irRate(10), irRate(200), irRate(400), irRate(800)]).toEqual([0.225, 0.2, 0.175, 0.15]);
    expect([iofRate(1), iofRate(15), iofRate(30)]).toEqual([0.96, 0.5, 0]);
    const old = estimateNet([{ date: "2024-01-01", amountCents: 1_000_000 }], 100_00, "2026-10-01", { exempt: false });
    expect(old).toMatchObject({ grossGainCents: 10000, iofCents: 0, irCents: 1500, netGainCents: 8500 });
    const young = estimateNet([{ date: "2026-09-21", amountCents: 1_000_000 }], 1000, "2026-10-01", { exempt: false });
    expect(young.iofCents).toBe(Math.round(1000 * 0.66));
    expect(young.irCents).toBe(Math.round((1000 - 1000 * 0.66) * 0.225));
    expect(estimateNet([{ date: "2026-09-21", amountCents: 1_000_000 }], 1000, "2026-10-01", { exempt: true })).toMatchObject({ irCents: 0, iofCents: 0, netGainCents: 1000 });
  });
});

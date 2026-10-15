import { describe, expect, it } from "vitest";
import { formatBRL, parseAmountToCents, splitEvenly, splitByWeights, percentChange } from "@/lib/money";

describe("money", () => {
  it("formata em BRL", () => {
    expect(formatBRL(123456)).toBe("R$ 1.234,56");
    expect(formatBRL(-500)).toBe("-R$ 5,00");
    expect(formatBRL(0)).toBe("R$ 0,00");
  });

  it.each([
    ["1.234,56", 123456],
    ["283,90", 28390],
    ["283.90", 28390],
    ["3.500", 350000],
    ["2.400", 240000],
    ["45", 4500],
    ["R$ 12,50", 1250],
    ["1,234.56", 123456],
    ["-10,00", -1000],
    ["0,5", 50],
    ["1.000.000,00", 100000000],
  ])("interpreta %s", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it("rejeita entradas inválidas", () => {
    expect(parseAmountToCents("abc")).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("12,345,6")).toBeNull();
  });

  it("divide parcelas preservando o total (resto na primeira)", () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(360000, 12).every((v) => v === 30000)).toBe(true);
    const parts = splitEvenly(99999, 7);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99999);
  });

  it("divide por pesos sem perder centavos", () => {
    const parts = splitByWeights(1001, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it("calcula variação percentual", () => {
    expect(percentChange(118, 100)).toBe(18);
    expect(percentChange(50, 0)).toBeNull();
  });
});

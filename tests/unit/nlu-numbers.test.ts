import { describe, expect, it } from "vitest";
import { extractAmounts, extractInstallments, amountMentioned, spelledToNumber } from "@/server/ai/nlu/numbers";

const cents = (t: string) => extractAmounts(t).map((a) => a.cents);

describe("NLU — valores", () => {
  it.each([
    ["Gastei 45 reais na farmácia.", [4500]],
    ["Mercado 283,90 no Nubank.", [28390]],
    ["Hoje abasteci 150 reais.", [15000]],
    ["Recebi 3.500 de um cliente.", [350000]],
    ["Paguei 120 de internet.", [12000]],
    ["Comprei uma televisão de 2.400 em 10 vezes.", [240000]],
    ["Ontem minha esposa gastou 78 reais na padaria.", [7800]],
    ["Transferi 500 reais do Itaú para o Nubank.", [50000]],
    ["Corrige aquela compra do supermercado. Foram 325 reais.", [32500]],
    ["Hoje gastei 80 reais de gasolina, 35 na farmácia e 120 no supermercado.", [8000, 3500, 12000]],
    ["Separei 500 reais para a viagem.", [50000]],
    ["Comprei um notebook de R$ 3.600 em 12 vezes no Nubank", [360000]],
    ["uber 23", [2300]],
    ["pizza 45 ifood", [4500]],
    ["comprei 3 camisas por 150", [15000]],
    ["comprei dois pães por 10 reais", [1000]],
    ["dia 5 paguei 89,90 de luz", [8990]],
    ["gastei 2 mil no conserto do carro", [200000]],
    ["recebi 1,5 mil de bônus", [150000]],
    ["vendi o celular por 2k", [200000]],
    ["abasteci 40 litros, deu 250", [25000]],
    ["Registrei errado o mercado. Foram 285 e não 258.", [28500, 25800]],
  ])("%s", (text, expected) => {
    expect(cents(text)).toEqual(expected);
  });

  it("valores por extenso (áudio transcrito)", () => {
    expect(cents("Amor, passei no supermercado hoje e gastei duzentos e trinta e quatro reais e cinquenta centavos. Foi no cartão de crédito.")).toEqual([23450]);
    expect(cents("Recebi hoje os dois mil reais daquele trabalho de marketing.")).toEqual([200000]);
    expect(cents("gastei mil e quinhentos reais no aluguel")).toEqual([150000]);
    expect(cents("gastei vinte e cinco na farmácia")).toEqual([2500]);
    expect(cents("três mil e duzentos reais de salário")).toEqual([320000]);
  });

  it("valor da parcela é identificado", () => {
    const a = extractAmounts("comprei uma geladeira em 10 vezes de 300 reais");
    expect(a).toHaveLength(1);
    expect(a[0]!.isInstallmentValue).toBe(true);
  });

  it("parcelas", () => {
    expect(extractInstallments("Comprei uma televisão de 2.400 em 10 vezes.")).toBe(10);
    expect(extractInstallments("notebook 3600 12x no nubank")).toBe(12);
    expect(extractInstallments("Na verdade, foram três parcelas.")).toBe(3);
    expect(extractInstallments("mercado 200")).toBeNull();
  });

  it("verificação anti-alucinação", () => {
    expect(amountMentioned("gastei 45 na farmácia", 4500)).toBe(true);
    expect(amountMentioned("gastei 45 na farmácia", 5400)).toBe(false);
    expect(spelledToNumber(["duzentos", "e", "trinta", "e", "quatro"])).toBe(234);
  });
});

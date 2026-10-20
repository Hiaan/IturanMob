import { describe, expect, it } from "vitest";
import { boletoLabel, dueDateFromFactor, findBoletoInText, formatDigitableLine, isBoleto, parseBoleto } from "@/lib/boleto";

/**
 * Linhas geradas por uma implementação independente (Python) do padrão FEBRABAN: bancário com
 * vencimento novo (fator reiniciado em 22/02/2025) e antigo, arrecadação em módulo 10 e 11.
 */
const TODAY = "2026-10-20";
const BANK_341 = { line: "34191790011010435100147910201509316310000023050", barcode: "34193163100000230501790010104351004791020150" };
const BANK_237_OLD = { line: "23793381286000000000424000000000197120000150000", barcode: "23791971200001500003381260000000002400000000" };
const UTIL_ENERGY = { line: "836600000019899000360003000000000000001234567897", barcode: "83660000001899000360000000000000000123456789" };
const UTIL_WATER = { line: "828300000007755012345670890123456785901234567894", barcode: "82830000000755012345678901234567890123456789" };

describe("boleto: linha digitável e código de barras", () => {
  it("bancário: banco, valor e vencimento (fator reiniciado em 2025)", () => {
    const b = parseBoleto(BANK_341.line, TODAY);
    expect(b).toEqual({
      kind: "BANK",
      digitableLine: BANK_341.line,
      barcode: BANK_341.barcode,
      amountCents: 23_050,
      dueDate: "2026-11-15",
      bankCode: "341",
      bankName: "Itaú",
      segment: null,
    });
    // Formatado com pontos e espaços, ou como código de barras: o mesmo boleto.
    expect(parseBoleto(formatDigitableLine(BANK_341.line), TODAY)).toEqual(b);
    expect(parseBoleto(BANK_341.barcode, TODAY)).toEqual(b);
    expect(formatDigitableLine(BANK_341.line)).toBe("34191.79001 10104.351001 47910.201509 3 16310000023050");
  });

  it("bancário antigo (antes da virada do fator) continua com a data certa", () => {
    expect(parseBoleto(BANK_237_OLD.line, TODAY)).toMatchObject({ amountCents: 150_000, dueDate: "2024-05-10", bankName: "Bradesco" });
    expect(dueDateFromFactor("0000", TODAY)).toBeNull();
    // O mesmo fator 1000 é 03/07/2000 ou 22/02/2025: vale o mais próximo de hoje.
    expect(dueDateFromFactor("1000", TODAY)).toBe("2025-02-22");
    expect(dueDateFromFactor("1000", "2000-08-01")).toBe("2000-07-03");
  });

  it("arrecadação: valor do código, segmento e vencimento em aberto (módulo 10 e 11)", () => {
    expect(parseBoleto(UTIL_ENERGY.line, TODAY)).toMatchObject({ kind: "UTILITY", amountCents: 18_990, dueDate: null, segment: "Energia elétrica e gás", barcode: UTIL_ENERGY.barcode });
    expect(parseBoleto(UTIL_WATER.line, TODAY)).toMatchObject({ kind: "UTILITY", amountCents: 7_550, segment: "Água e saneamento", barcode: UTIL_WATER.barcode });
    expect(parseBoleto(UTIL_WATER.barcode, TODAY)).toMatchObject({ digitableLine: UTIL_WATER.line });
    expect(formatDigitableLine(UTIL_ENERGY.line)).toBe("83660000001-9 89900036000-3 00000000000-0 00123456789-7");
  });

  it("recusa dígito verificador errado e tamanho inválido (nada é adivinhado)", () => {
    const wrong = BANK_341.line.slice(0, 40) + (BANK_341.line[40] === "9" ? "8" : "9") + BANK_341.line.slice(41);
    expect(parseBoleto(wrong, TODAY)).toBe("CHECK_DIGIT");
    const wrongField = "3" + "5" + BANK_341.line.slice(2);
    expect(parseBoleto(wrongField, TODAY)).toBe("CHECK_DIGIT");
    expect(parseBoleto("1234", TODAY)).toBe("LENGTH");
    expect(parseBoleto(UTIL_WATER.line.slice(0, 47) + "0", TODAY)).toBe("CHECK_DIGIT");
    expect(isBoleto(parseBoleto("1234", TODAY))).toBe(false);
  });

  it("encontra a linha no meio de um texto (mensagem ou PDF)", () => {
    const text = `Pagável em qualquer banco\nVencimento 15/11/2026\n${formatDigitableLine(BANK_341.line)}\nValor R$ 230,50`;
    expect(findBoletoInText(text, TODAY)).toMatchObject({ amountCents: 23_050, dueDate: "2026-11-15" });
    expect(findBoletoInText(`pagar a conta de luz ${formatDigitableLine(UTIL_ENERGY.line)} ok`, TODAY)).toMatchObject({ kind: "UTILITY", amountCents: 18_990 });
    expect(findBoletoInText("telefone 81 99999-0000 e cpf 123.456.789-00", TODAY)).toBeNull();
    expect(boletoLabel(parseBoleto(BANK_341.line, TODAY) as never)).toBe("Boleto Itaú");
    expect(boletoLabel(parseBoleto(UTIL_ENERGY.line, TODAY) as never)).toBe("Conta: Energia elétrica e gás");
  });
});

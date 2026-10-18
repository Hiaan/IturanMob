import { describe, expect, it } from "vitest";
import { parseLastTxCommand } from "@/server/ai/nlu/last-tx";
import { makeHouseholdContext } from "../helpers/household-context";

/** Frases reais do usuário para corrigir ou cancelar o último lançamento (texto ou áudio). */
const hc = makeHouseholdContext();
const p = (t: string) => parseLastTxCommand(t, hc);

describe("parseLastTxCommand", () => {
  it("cancelar", () => {
    for (const t of ["cancela", "Cancelar", "esquece", "apaga", "apaga isso", "Cancela esse!", "não era pra lançar", "lancei errado, apaga", "não era isso, cancela", "apaga o último por favor", "exclui esse lançamento"]) {
      expect(p(t), t).toEqual({ action: "CANCEL" });
    }
  });

  it("desfazer e voltar", () => {
    expect(p("desfaz")).toEqual({ action: "UNDO" });
    expect(p("Desfazer")).toEqual({ action: "UNDO" });
    for (const t of ["volta", "restaura", "Volta!", "traz de volta", "apaguei errado"]) expect(p(t), t).toEqual({ action: "RESTORE" });
  });

  it("descrição: 'não é X, é Y', 'era Y', 'o nome é Y', 'errou, é Y', 'corrige pra Y', 'é Y'", () => {
    expect(p("não é revirante, é refrigerante")).toEqual({ action: "DESCRIBE", right: "refrigerante", wrong: "revirante", explicit: true });
    expect(p("Não é revirante é refrigerante")).toEqual({ action: "DESCRIBE", right: "refrigerante", wrong: "revirante", explicit: true });
    expect(p("é refrigerante, não revirante")).toEqual({ action: "DESCRIBE", right: "refrigerante", wrong: "revirante", explicit: true });
    for (const t of ["era refrigerante", "o nome é refrigerante", "errou, é refrigerante", "corrige pra refrigerante", "corrige: refrigerante", "na verdade é refrigerante", "eu falei refrigerante"]) {
      expect(p(t), t).toEqual({ action: "DESCRIBE", right: "refrigerante", wrong: null, explicit: true });
    }
    expect(p("é refrigerante")).toEqual({ action: "DESCRIBE", right: "refrigerante", wrong: null, explicit: false });
    expect(p("era pão de açúcar")).toEqual({ action: "DESCRIBE", right: "pão de açúcar", wrong: null, explicit: true });
  });

  it("valor, forma de pagamento e categoria", () => {
    for (const t of ["foram 15", "foi 15 reais", "não, 15 reais", "valor errado, 15", "na verdade foram R$ 15,00"]) expect(p(t), t).toEqual({ action: "AMOUNT", amountCents: 1_500 });
    expect(p("foi no crédito")).toMatchObject({ action: "PAYMENT", paymentMethod: "CREDIT_CARD" });
    expect(p("no débito")).toMatchObject({ action: "PAYMENT", paymentMethod: "DEBIT_CARD" });
    expect(p("foi no pix")).toMatchObject({ action: "PAYMENT", paymentMethod: "PIX" });
    expect(p("foi no cartão itaú visa")).toMatchObject({ action: "PAYMENT", paymentMethod: "CREDIT_CARD", cardHint: "Itaú Visa" });
    expect(p("muda pra mercado")).toEqual({ action: "CATEGORY", hint: "mercado" });
    expect(p("coloca em lazer")).toEqual({ action: "CATEGORY", hint: "lazer" });
    expect(p("a categoria é saúde")).toEqual({ action: "CATEGORY", hint: "saúde" });
  });

  it("não confunde com lançamento novo nem com outros comandos", () => {
    expect(p("2")).toBeNull(); // resposta "1 PF / 2 Empresa"
    expect(p("15")).toBeNull();
    for (const t of ["paguei 15 no uber", "gastei 30 de pão", "mercado 120", "15 de uber e 30 de pão", "quanto gastei este mês?", "cria categoria Pet", "isso é da empresa", "boa noite", "comprei refrigerante 8 reais no nubank"]) {
      const r = p(t);
      expect(r === null || (r.action === "DESCRIBE" && !r.explicit && t === "isso é da empresa"), `${t} → ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

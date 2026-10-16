import { describe, expect, it } from "vitest";
import { detectOwnMove, pickCounterpart, similarityKey, type AccountLite } from "@/server/modules/transfers/own-moves";

const acc = (id: string, name: string, type: AccountLite["type"], institution: string | null = null): AccountLite => ({ id, name, type, institution });

describe("movimentações entre contas próprias", () => {
  it("aplicação, resgate e mesma titularidade são transferência; rendimento, IOF e caixinha do porteiro não", () => {
    for (const d of ["RESGATE CDB", "APLICACAO RDB", "Aplicação na caixinha Viagem", "Dinheiro guardado", "Resgate do Porquinho", "APLIC AUT POUPANCA", "TESOURO DIRETO SELIC 2029", "Resgate LCI 90 dias", "CDB PRE 12,5%"]) {
      expect(detectOwnMove(d), d).toBe("INVESTMENT");
    }
    expect(detectOwnMove("TED MESMA TITULARIDADE")).toBe("OWN_ACCOUNTS");
    expect(detectOwnMove("Transferência entre contas")).toBe("OWN_ACCOUNTS");
    for (const d of ["RENDIMENTO POUPANCA", "Rendimentos CDB", "DIVIDENDOS ITSA4", "IOF RESGATE CDB", "IR S/ RESGATE", "PIX CAIXINHA DO PORTEIRO", "MERCADO BOM", "Transferência enviada pelo Pix FULANO", "APLICATIVO UBER"]) {
      expect(detectOwnMove(d), d).toBeNull();
    }
  });

  it("escolhe a conta do outro lado só quando não há dúvida", () => {
    const itau = acc("itau", "Itaú", "CHECKING", "Itaú");
    const cdbItau = acc("cdb-itau", "CDB Itaú", "INVESTMENT", "Itaú");
    const poup = acc("poup", "Poupança Caixa", "SAVINGS", "Caixa");
    const nuCaixinha = acc("nu-cx", "Caixinhas Nubank", "INVESTMENT", "Nubank");
    const nubank = acc("nu", "Nubank", "DIGITAL", "Nubank");
    // Uma única conta de investimento: é ela.
    expect(pickCounterpart("RESGATE CDB", "INVESTMENT", itau, [itau, cdbItau])?.id).toBe("cdb-itau");
    // Várias: o nome citado decide; depois o tipo (poupança); depois a mesma instituição.
    const all = [itau, cdbItau, poup, nuCaixinha, nubank];
    expect(pickCounterpart("RESGATE CDB", "INVESTMENT", itau, all)?.id).toBe("cdb-itau");
    expect(pickCounterpart("APLICACAO POUPANCA", "INVESTMENT", itau, all)?.id).toBe("poup");
    expect(pickCounterpart("Aplicação na caixinha", "INVESTMENT", nubank, all)?.id).toBe("nu-cx");
    expect(pickCounterpart("RESGATE AUTOMATICO", "INVESTMENT", itau, all)?.id).toBe("cdb-itau");
    // Extrato da conta de investimento: o outro lado é uma conta de movimento.
    expect(pickCounterpart("APLICACAO", "INVESTMENT", cdbItau, all)?.id).toBe("itau");
    // Sem conta de investimento, ou ambíguo: null (a pessoa escolhe).
    expect(pickCounterpart("RESGATE CDB", "INVESTMENT", itau, [itau, nubank])).toBeNull();
    expect(pickCounterpart("TED MESMA TITULARIDADE", "OWN_ACCOUNTS", itau, all)).toBeNull();
    expect(pickCounterpart("TED MESMA TITULARIDADE NUBANK", "OWN_ACCOUNTS", itau, [itau, nubank, poup])?.id).toBe("nu");
  });

  it("linhas parecidas compartilham a chave sem números", () => {
    expect(similarityKey("RESGATE CDB 000123")).toBe("resgate cdb");
    expect(similarityKey("RESGATE CDB 998877")).toBe("resgate cdb");
    expect(similarityKey("123456")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { hasExclusionMarker, parseExclusionCommand, stripExclusionMarker } from "@/server/ai/engine/report-exclusion";

describe("WhatsApp: comando 'desconsiderar nos relatórios'", () => {
  it("reconhece desconsiderar, repasse e reembolso com o cliente", () => {
    expect(parseExclusionCommand("o pix do fulano é repasse")).toMatchObject({ action: "EXCLUDE", reason: "CLIENT_PASSTHROUGH", party: "Fulano", targetType: "INCOME" });
    expect(parseExclusionCommand("desconsidera esse")).toMatchObject({ action: "EXCLUDE", reason: "OTHER", party: null, targetText: null });
    expect(parseExclusionCommand("Desconsidera esse, é repasse do cliente Maria Souza")).toMatchObject({ reason: "CLIENT_PASSTHROUGH", party: "Maria Souza" });
    expect(parseExclusionCommand("isso foi reembolso")).toMatchObject({ action: "EXCLUDE", reason: "REIMBURSEMENT", party: null });
    expect(parseExclusionCommand("marca como repasse o anúncio do cliente Padaria Sol")).toMatchObject({ reason: "CLIENT_PASSTHROUGH", party: "Padaria Sol", targetType: "EXPENSE" });
    expect(parseExclusionCommand("desconsidera o pix de 500 do João")).toMatchObject({ party: "Joao", targetAmountCents: 50_000 });
  });

  it("desfazer", () => {
    expect(parseExclusionCommand("considerar de novo")).toMatchObject({ action: "INCLUDE" });
    expect(parseExclusionCommand("volta a considerar o pix do fulano")).toMatchObject({ action: "INCLUDE", party: "Fulano" });
    expect(parseExclusionCommand("não é repasse")).toMatchObject({ action: "INCLUDE" });
  });

  it("não confunde com lançamento novo, exclusão da mensagem ou conversa comum", () => {
    expect(parseExclusionCommand("recebi 500 do fulano, é repasse")).toBeNull();
    expect(parseExclusionCommand("desconsidera a mensagem anterior")).toBeNull();
    expect(parseExclusionCommand("gastei 50 no mercado")).toBeNull();
    expect(parseExclusionCommand("quanto gastamos esse mês?")).toBeNull();
    expect(parseExclusionCommand("apaga o último")).toBeNull();
  });

  it("marcador em lançamento novo: detecta, extrai o cliente e sai do texto", () => {
    expect(hasExclusionMarker("recebi 200 do Beltrano, é repasse")).toMatchObject({ reason: "CLIENT_PASSTHROUGH", party: "Beltrano" });
    expect(hasExclusionMarker("gastei 300 no facebook ads, foi reembolso")).toMatchObject({ reason: "REIMBURSEMENT" });
    expect(hasExclusionMarker("gastei 40 na padaria")).toBeNull();
    expect(hasExclusionMarker("desconsidera a mensagem anterior")).toBeNull();
    expect(stripExclusionMarker("recebi 200 do Beltrano, é repasse")).toBe("recebi 200 do Beltrano");
    expect(stripExclusionMarker("gastei 300 no facebook ads, foi reembolso")).toBe("gastei 300 no facebook ads");
  });

  it("natureza Empresa/Pessoal", () => {
    expect(parseExclusionCommand("isso é da empresa")).toMatchObject({ action: "BUSINESS", targetText: null });
    expect(parseExclusionCommand("marca como empresa o pix do daniel")).toMatchObject({ action: "BUSINESS" });
    expect(parseExclusionCommand("isso é pessoal")).toMatchObject({ action: "PERSONAL" });
    expect(parseExclusionCommand("não é da empresa")).toMatchObject({ action: "PERSONAL" });
    expect(parseExclusionCommand("paguei 750 pro Ícaro, empresa")).toBeNull();
    // "empresa" no lançamento novo é natureza (decidida na criação), não marcador de repasse.
    expect(hasExclusionMarker("paguei 750 pro Ícaro, empresa")).toBeNull();
    expect(hasExclusionMarker("gastei 200 em tráfego, foi da empresa")).toBeNull();
    expect(hasExclusionMarker("gastei 50 no mercado")).toBeNull();
  });
});

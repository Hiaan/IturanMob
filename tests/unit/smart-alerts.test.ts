import { describe, expect, it } from "vitest";
import { chargeKey, detectMonthlyCharges, isPriceRaise, type ChargeTx } from "@/server/modules/subscriptions/service";
import { findShortfall, shortfallText } from "@/server/modules/alerts/cash";
import { parseReportCommand } from "@/server/ai/engine/report-commands";
import { descriptionFromCaption, parseDueDateAnswer } from "@/server/ai/engine/boleto-commands";
import { boletoFromDocumentText, boletoHintsFromText, cleanBeneficiary } from "@/server/modules/bills/boleto-reader";
import { formatDigitableLine } from "@/lib/boleto";

const TODAY = "2026-10-20";
let seq = 0;
const tx = (date: string, amountCents: number, description: string, extra: Partial<ChargeTx> = {}): ChargeTx => ({
  id: `t${++seq}`,
  date,
  amountCents,
  description,
  merchantId: null,
  merchantName: null,
  categoryId: null,
  accountId: null,
  creditCardId: "card",
  ...extra,
});

describe("assinaturas: cobrança mensal esquecida", () => {
  it("chave do estabelecimento ignora prefixos, datas e parcelas", () => {
    expect(chargeKey("PG *NETFLIX.COM 10/10")).toBe("netflix");
    expect(chargeKey("Netflix")).toBe("netflix");
    expect(chargeKey("SPOTIFY P1234ABC")).toBe("spotify p1234abc");
    expect(chargeKey("123 456")).toBe("");
  });

  it("3 meses seguidos com ~30 dias: encontra, com o aumento de preço", () => {
    const found = detectMonthlyCharges(
      [tx("2026-07-12", 5_590, "PG *NETFLIX.COM"), tx("2026-08-12", 5_590, "NETFLIX.COM"), tx("2026-09-12", 5_590, "Netflix"), tx("2026-10-12", 5_990, "NETFLIX.COM 12/10")],
      TODAY,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: "d:netflix", occurrences: 4, amountCents: 5_990, previousAmountCents: 5_590, firstChargeDate: "2026-07-12", lastChargeDate: "2026-10-12" });
    expect(isPriceRaise(5_590, 5_990)).toBe(true);
    expect(isPriceRaise(5_590, 5_600)).toBe(false); // 10 centavos não é aumento
    expect(isPriceRaise(null, 5_990)).toBe(false);
  });

  it("não confunde compras frequentes, cobranças antigas ou só 2 meses com assinatura", () => {
    const market = [tx("2026-08-03", 25_000, "Mercado Bom Preço"), tx("2026-08-20", 18_000, "Mercado Bom Preço"), tx("2026-09-03", 22_000, "Mercado Bom Preço"), tx("2026-10-02", 21_000, "Mercado Bom Preço")];
    const old = [tx("2026-03-05", 3_990, "Deezer"), tx("2026-04-05", 3_990, "Deezer"), tx("2026-05-05", 3_990, "Deezer")];
    const twoMonths = [tx("2026-09-01", 1_990, "Globoplay"), tx("2026-10-01", 1_990, "Globoplay")];
    const jumpy = [tx("2026-08-10", 10_000, "Loja X"), tx("2026-09-10", 40_000, "Loja X"), tx("2026-10-10", 9_000, "Loja X")];
    expect(detectMonthlyCharges([...market, ...old, ...twoMonths, ...jumpy], TODAY)).toEqual([]);
  });

  it("agrupa pelo estabelecimento cadastrado quando houver", () => {
    const m = { merchantId: "m1", merchantName: "Academia Fit" };
    const found = detectMonthlyCharges([tx("2026-08-05", 9_900, "Pix academia", m), tx("2026-09-04", 9_900, "Mensalidade", m), tx("2026-10-05", 9_900, "Academia", m)], TODAY);
    expect(found).toMatchObject([{ key: "m:m1", name: "Academia Fit", occurrences: 3 }]);
  });
});

describe("vai faltar dinheiro", () => {
  const base = {
    startDate: TODAY,
    startBalanceCents: 100_000,
    lowestPoint: { date: "2026-11-10", balanceCents: -80_000 },
    points: [
      { date: TODAY, balanceCents: 100_000 },
      { date: "2026-10-25", balanceCents: 20_000 },
      { date: "2026-11-05", balanceCents: -30_000 },
      { date: "2026-11-10", balanceCents: -80_000 },
    ],
    events: [
      { date: "2026-10-25", description: "Aluguel", amountCents: -80_000, kind: "SCHEDULED_EXPENSE" as const, certainty: "CONFIRMED" as const },
      { date: "2026-11-05", description: "Fatura Nubank (2026-10)", amountCents: -50_000, kind: "CARD_STATEMENT" as const, certainty: "CONFIRMED" as const },
      { date: "2026-11-10", description: "Escola", amountCents: -50_000, kind: "SCHEDULED_EXPENSE" as const, certainty: "CONFIRMED" as const },
    ],
  };

  it("primeiro dia negativo, pior momento e maiores saídas até lá", () => {
    const s = findShortfall(base)!;
    expect(s).toMatchObject({ date: "2026-11-05", balanceCents: -30_000, lowest: { date: "2026-11-10", balanceCents: -80_000 } });
    expect(s.drivers.map((d) => d.description)).toEqual(["Aluguel", "Fatura Nubank (2026-10)"]);
    const text = shortfallText(s, TODAY);
    expect(text.title).toBe("Vai faltar dinheiro");
    expect(text.body).toContain("fica negativo em 05/11/2026");
    expect(text.body).toContain("Pior momento");
    expect(text.body).toContain("Aluguel");
    expect(text.body).toContain("Conta só o que está cadastrado");
  });

  it("saldo sempre positivo: sem aviso", () => {
    expect(findShortfall({ ...base, points: base.points.slice(0, 2), lowestPoint: { date: "2026-10-25", balanceCents: 20_000 } })).toBeNull();
  });
});

describe("pedir relatório ou planilha pelo WhatsApp", () => {
  it("entende período, formato e natureza", () => {
    expect(parseReportCommand("manda o relatório do mês", TODAY)).toEqual({ kind: "MONTHLY", ref: "2026-10", format: "pdf", nature: null });
    expect(parseReportCommand("me envia a planilha do mês passado", TODAY)).toEqual({ kind: "MONTHLY", ref: "2026-09", format: "xlsx", nature: null });
    expect(parseReportCommand("quero o relatório de setembro em pdf", TODAY)).toMatchObject({ ref: "2026-09", format: "pdf" });
    expect(parseReportCommand("relatório de dezembro", TODAY)).toMatchObject({ ref: "2025-12" });
    expect(parseReportCommand("manda o relatório da semana", TODAY)).toMatchObject({ kind: "WEEKLY", ref: "2026-10-19" });
    expect(parseReportCommand("relatório da semana passada", TODAY)).toMatchObject({ kind: "WEEKLY", ref: "2026-10-12" });
    expect(parseReportCommand("manda o relatório da empresa", TODAY)).toMatchObject({ nature: "BUSINESS" });
    expect(parseReportCommand("gera um excel de agosto 2026", TODAY)).toMatchObject({ ref: "2026-08", format: "xlsx" });
  });

  it("não confunde com lançamentos, perguntas ou importação", () => {
    expect(parseReportCommand("gastei 50 no mercado", TODAY)).toBeNull();
    expect(parseReportCommand("quanto gastei esse mês?", TODAY)).toBeNull();
    expect(parseReportCommand("como importar minha planilha?", TODAY)).toBeNull();
    expect(parseReportCommand("o relatório chegou certinho, obrigado pela ajuda de ontem com tudo aquilo que eu pedi sobre as contas e os gastos da casa e da empresa e mais coisas", TODAY)).toBeNull();
  });
});

describe("boleto pelo WhatsApp: respostas e documento", () => {
  it("vencimento na resposta: dd/mm, dd/mm/aaaa e 'dia 15'", () => {
    expect(parseDueDateAnswer("15/11", TODAY)).toBe("2026-11-15");
    expect(parseDueDateAnswer("vence 05/01/2027", TODAY)).toBe("2027-01-05");
    expect(parseDueDateAnswer("10/01", TODAY)).toBe("2027-01-10"); // janeiro já passou → próximo ano
    expect(parseDueDateAnswer("dia 25", TODAY)).toBe("2026-10-25");
    expect(parseDueDateAnswer("dia 5", TODAY)).toBe("2026-11-05");
    expect(parseDueDateAnswer("31/02", TODAY)).toBeNull();
    expect(parseDueDateAnswer("amanhã", TODAY)).toBeNull();
  });

  it("descrição pela legenda, sem o código", () => {
    const line = formatDigitableLine("34191790011010435100147910201509316310000023050");
    expect(descriptionFromCaption(`boleto da escola ${line}`)).toBe("Escola");
    expect(descriptionFromCaption(`${line}`)).toBeNull();
    expect(descriptionFromCaption(`pagar condomínio ${line}`)).toBe("Condomínio");
    expect(descriptionFromCaption(`paguei ${line}`)).toBeNull();
  });

  it("dados impressos no documento e comprovante de boleto pago", () => {
    const line = formatDigitableLine("836600000019899000360003000000000000001234567897");
    const lines = ["Companhia Energética", "Beneficiário: NEOENERGIA PERNAMBUCO CNPJ 10.835.932/0001-08", "Vencimento", "28/10/2026", "Total a pagar R$ 189,90", line];
    expect(boletoHintsFromText(lines, TODAY)).toEqual({ beneficiary: "NEOENERGIA PERNAMBUCO", dueDate: "2026-10-28", amountCents: 18_990 });
    expect(boletoFromDocumentText(lines, TODAY)).toMatchObject({ status: "BOLETO", boleto: { kind: "UTILITY", amountCents: 18_990 } });
    expect(boletoFromDocumentText(["Comprovante de pagamento", "Pagamento realizado", line], TODAY)).toEqual({ status: "PAID_RECEIPT" });
    expect(boletoFromDocumentText(["Extrato", "nada de boleto aqui 12345"], TODAY)).toEqual({ status: "NOT_BOLETO" });
    expect(cleanBeneficiary("CPF 123.456.789-00")).toBeNull();
  });
});

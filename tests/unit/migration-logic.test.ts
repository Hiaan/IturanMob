import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "@/server/modules/categories/defaults";
import {
  detectColumns,
  installmentFromDescription,
  isTotalLabel,
  parseFlowType,
  parseInstallment,
  parseMigrationDate,
  parseNatureValue,
  parsePaymentMethodValue,
  parseStatusValue,
} from "@/server/modules/migration/columns";
import { parseMonthName } from "@/server/modules/migration/classify";
import { suggestCategory, suggestDestination, suggestMember, type Catalog } from "@/server/modules/migration/correspondences";
import { buildMigrationRows, type Resolution } from "@/server/modules/migration/rows";
import { applyTemplateToSheets, buildTemplateConfig, sheetSignature } from "@/server/modules/migration/template";
import type { ColumnMap, SheetConfig } from "@/server/modules/migration/types";
import type { RawSheet } from "@/server/modules/migration/workbook";

let seq = 0;
const catalog: Catalog = {
  categories: DEFAULT_CATEGORIES.map((c) => ({
    id: `c${seq++}`,
    name: c.name,
    kind: c.kind,
    subcategories: c.subcategories.map((s) => ({ id: `s${seq++}`, name: s.name, keywords: s.keywords })),
  })),
  accounts: [
    { id: "acc-itau", name: "Itaú Corrente", institution: "Itaú", type: "CHECKING" },
    { id: "acc-poup", name: "Poupança Itaú", institution: "Itaú", type: "SAVINGS" },
    { id: "acc-bb", name: "Conta BB", institution: "Banco do Brasil", type: "CHECKING" },
  ],
  cards: [
    { id: "card-nu", name: "Nubank", issuer: "Nubank", last4: "1234" },
    { id: "card-xp", name: "XP Visa Infinite", issuer: "XP", last4: null },
  ],
  members: [
    { id: "m-joao", name: "João Silva" },
    { id: "m-maria", name: "Maria" },
  ],
  currentMemberId: "m-joao",
};

describe("valores das colunas extras", () => {
  it("parcelas", () => {
    expect(parseInstallment("3/10")).toEqual({ number: 3, total: 10, purchaseTotal: false });
    expect(parseInstallment("parcela 3 de 10")).toEqual({ number: 3, total: 10, purchaseTotal: false });
    expect(parseInstallment("Parc. 02/12")).toEqual({ number: 2, total: 12, purchaseTotal: false });
    expect(parseInstallment("3x")).toEqual({ number: 1, total: 3, purchaseTotal: true });
    expect(parseInstallment("em 10 vezes")).toEqual({ number: 1, total: 10, purchaseTotal: true });
    expect(parseInstallment("à vista")).toBeNull();
    expect(parseInstallment("1/1")).toBeNull();
    expect(parseInstallment("11/10")).toBeNull();
    expect(installmentFromDescription("Geladeira Brastemp (3/10)")).toEqual({ info: { number: 3, total: 10, purchaseTotal: false }, base: "Geladeira Brastemp" });
    expect(installmentFromDescription("TV Samsung parc 2/12 loja")?.base).toBe("TV Samsung loja");
    expect(installmentFromDescription("Sofá 3 de 10")?.info.number).toBe(3);
    expect(installmentFromDescription("Conta 2025")).toBeNull();
  });

  it("natureza, tipo, status, forma de pagamento e linhas de total", () => {
    expect(["PF", "Pessoal", "pessoa física", "PJ", "Empresa", "Repasse"].map(parseNatureValue)).toEqual(["PERSONAL", "PERSONAL", "PERSONAL", "BUSINESS", "BUSINESS", "PASSTHROUGH"]);
    expect(["Entrada", "receita", "C", "+", "Saída", "despesa", "D", "-", "Transferência", "talvez"].map(parseFlowType)).toEqual(["IN", "IN", "IN", "IN", "OUT", "OUT", "OUT", "OUT", "TRANSFER", null]);
    expect(["Pago", "✓", "ok", "A pagar", "pendente", "em aberto", "a receber", "?"].map(parseStatusValue)).toEqual(["PAID", "PAID", "PAID", "TO_PAY", "TO_PAY", "TO_PAY", "TO_PAY", null]);
    expect(["Pix", "Débito", "Crédito", "cartão", "Dinheiro", "boleto", "TED", "VR", "débito automático"].map(parsePaymentMethodValue)).toEqual([
      "PIX", "DEBIT_CARD", "CREDIT_CARD", "CREDIT_CARD", "CASH", "BANK_SLIP", "BANK_TRANSFER", "VOUCHER", "AUTO_DEBIT",
    ]);
    expect(["Total", "Total Janeiro", "SUBTOTAL", "Saldo final", "Saldo anterior", "Totalmente novo", "Mercado"].map(isTotalLabel)).toEqual([true, true, true, true, true, false, false]);
  });

  it("datas com e sem ano", () => {
    expect(parseMigrationDate("15/03", { year: 2025, month: null })).toBe("2025-03-15");
    expect(parseMigrationDate("15/03/2024", { year: 2025, month: null })).toBe("2024-03-15");
    expect(parseMigrationDate("31/02", { year: 2025, month: null })).toBeNull();
    expect(parseMigrationDate("15/03", { year: null, month: null })).toBeNull();
  });

  it("mês e ano no nome da aba", () => {
    expect(parseMonthName("Janeiro")).toEqual({ month: 1, year: null });
    expect(parseMonthName("Jan/25")).toEqual({ month: 1, year: 2025 });
    expect(parseMonthName("01-2025")).toEqual({ month: 1, year: 2025 });
    expect(parseMonthName("2025-03")).toEqual({ month: 3, year: 2025 });
    expect(parseMonthName("Março de 2024")).toEqual({ month: 3, year: 2024 });
    expect(parseMonthName("Gastos Fevereiro 2025")).toEqual({ month: 2, year: 2025 });
    expect(parseMonthName("DEZ24")).toEqual({ month: 12, year: 2024 });
    expect(parseMonthName("Resumo")).toBeNull();
    expect(parseMonthName("Viagem ao mar e praia")).toBeNull();
  });

  it("colunas pelo nome, conferidas pelo conteúdo", () => {
    const headers = ["Dia", "O que", "Quanto", "Cartão", "Quem", "Parcela", "Pago?", "Obs."];
    const rows = [
      ["5", "Mercado", "120,50", "Nubank", "João", "1/3", "sim", "x"],
      ["12", "Farmácia", "30,00", "", "Maria", "", "não", ""],
      ["Total", "", "150,50", "", "", "", "", ""],
    ];
    const c = detectColumns(headers, rows);
    expect([c.day, c.description, c.amount, c.card, c.person, c.installment, c.status, c.notes]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(c.date).toBeNull();
    // "Conta" com muitos nomes diferentes é a descrição (planilha de contas da casa).
    const bills = detectColumns(["Conta", "Vencimento", "Valor"], Array.from({ length: 15 }, (_, i) => [`Conta ${i}`, `10/${String((i % 12) + 1).padStart(2, "0")}/2025`, "100,00"]));
    expect(bills.description).toBe(0);
    expect(bills.account).toBeNull();
  });
});

describe("sugestões do De → Para", () => {
  const cat = (label: string, kind: "EXPENSE" | "INCOME" | null = "EXPENSE", parent: string | null = null) => suggestCategory(label, kind, catalog, parent);

  it("igual, parecido (acentos, plural, abreviação) e sinônimos", () => {
    expect(cat("Supermercado")).toMatchObject({ label: "Alimentação › Supermercado", source: "EXACT" });
    expect(cat("alimentacao")).toMatchObject({ label: "Alimentação", source: "EXACT" });
    expect(cat("Restaurante")).toMatchObject({ label: "Alimentação › Restaurantes", source: "SIMILAR" });
    expect(cat("Alim.")).toMatchObject({ label: "Alimentação", source: "SIMILAR" });
    expect(cat("Mercado")).toMatchObject({ label: "Alimentação › Supermercado", source: "SYNONYM" });
    expect(cat("Combustível")).toMatchObject({ label: "Transporte › Combustível", source: "EXACT" });
    expect(cat("Gasolina")).toMatchObject({ label: "Transporte › Combustível", source: "SYNONYM" });
    expect(cat("Luz")).toMatchObject({ label: "Moradia › Energia" });
    expect(cat("Conta de luz da casa")).toMatchObject({ label: "Moradia › Energia" });
    expect(cat("Moradia > Água")).toMatchObject({ label: "Moradia › Água", source: "EXACT" });
    expect(cat("Salario", "INCOME")).toMatchObject({ label: "Trabalho › Salário" });
    expect(cat("Diversos", "INCOME")).toMatchObject({ label: "Outras receitas › Outros" });
    expect(cat("Diversos", "EXPENSE")).toMatchObject({ label: "Outras › Despesas não classificadas" });
    expect(cat("Outros", "EXPENSE", "Família")).toMatchObject({ label: "Família › Outros", source: "EXACT" });
    expect(cat("Pets")).toBeNull();
    expect(cat("Impostos")).toMatchObject({ label: "Outras › Impostos" });
  });

  it("contas, cartões e pessoas", () => {
    expect(suggestDestination("itau", "account", catalog)).toMatchObject({ targetType: "ACCOUNT", targetId: "acc-itau" });
    expect(suggestDestination("Poupança", "account", catalog)).toMatchObject({ targetId: "acc-poup" });
    expect(suggestDestination("BB", "account", catalog)).toMatchObject({ targetId: "acc-bb" });
    expect(suggestDestination("Nubank Crédito", "account", catalog)).toMatchObject({ targetType: "CARD", targetId: "card-nu" });
    expect(suggestDestination("final 1234", "card", catalog)).toMatchObject({ targetId: "card-nu" });
    expect(suggestDestination("XP", "card", catalog)).toMatchObject({ targetId: "card-xp" });
    expect(suggestDestination("Carteira", "account", catalog)).toBeNull();
    expect(suggestMember("joao", catalog)).toMatchObject({ targetId: "m-joao", source: "SIMILAR" });
    expect(suggestMember("Maria", catalog)).toMatchObject({ targetId: "m-maria", source: "EXACT" });
    expect(suggestMember("eu", catalog)).toMatchObject({ targetId: "m-joao" });
    expect(suggestMember("ambos", catalog)).toBeNull();
  });
});

function listConfig(headers: string[], columns: Partial<ColumnMap>, extra: Partial<SheetConfig> = {}): SheetConfig {
  const base = Object.fromEntries(["date", "day", "description", "amount", "debit", "credit", "type", "category", "subcategory", "account", "card", "paymentMethod", "person", "nature", "installment", "status", "notes", "balance", "externalId"].map((f) => [f, null])) as ColumnMap;
  return {
    index: 0, name: "Lista", hidden: false, truncated: false, rowCount: 0, detectedKind: "LIST", kind: "LIST", reason: "", selected: true, headerRowIndex: 0, headers,
    columns: { ...base, ...columns }, month: null, yearGuessed: false, unsigned: false, unsignedAs: null, invertSigns: false, matrix: null, matrixMode: null,
    dataRows: 0, ignoredRows: 0, sample: [], warnings: [], fromTemplate: false, signature: "", ...extra,
  };
}

const emptyRes = (): Resolution => ({ category: new Map(), subcategory: new Map(), account: new Map(), card: new Map(), person: new Map(), nature: new Map() });

describe("montagem das linhas", () => {
  const headers = ["Data", "Descrição", "Valor", "Conta", "Parcela", "Status"];
  const sheet = (rows: string[][]): RawSheet => ({ name: "Lista", hidden: false, rows: [headers, ...rows], rowNumbers: [1, ...rows.map((_, i) => i + 2)], truncated: false });
  const cfg = listConfig(headers, { date: 0, description: 1, amount: 2, account: 3, installment: 4, status: 5 });

  it("cartão: 3/10, 4/10, 5/10 viram UMA compra a partir da parcela 3; 10x usa o valor total", () => {
    const res = emptyRes();
    res.account.set("nubank", { accountId: null, creditCardId: "card-nu" });
    const out = buildMigrationRows(
      [{ sheet: sheet([["2025-03-05", "Geladeira (3/10)", "-250", "Nubank", "", ""], ["2025-04-05", "Geladeira (4/10)", "-250", "Nubank", "", ""], ["2025-05-05", "Geladeira (5/10)", "-250", "Nubank", "", ""], ["2025-02-10", "Notebook", "-5000", "Nubank", "10x", ""]]), cfg }],
      res,
      { fileName: "f.xlsx", today: "2026-10-19", defaultAccountId: null, defaultCardId: null, contextYear: 2025 },
    );
    const [first, second, third, notebook] = out.rows;
    expect(first!.parsed.meta.installmentPlan).toEqual({ count: 8, amountCents: 200_000, firstNumber: 3, ofTotal: 10 });
    expect(first!.parsed.description).toBe("Geladeira (parcelas 3 a 10 de 10)");
    expect(second!.parsed.skipReason).toMatch(/Parcela 4\/10 já incluída/);
    expect(third!.parsed.skipReason).toMatch(/Parcela 5\/10 já incluída/);
    expect(notebook!.parsed.meta.installmentPlan).toEqual({ count: 10, amountCents: 500_000, firstNumber: 1, ofTotal: 10 });
    expect(out.rows.every((r) => r.dest === "C:card-nu")).toBe(true);
  });

  it("conta: parcelas futuras (a partir de hoje) viram contas a pagar; 'a pagar' não é movimento de caixa", () => {
    const res = emptyRes();
    res.account.set("itau", { accountId: "acc-itau", creditCardId: null });
    const out = buildMigrationRows(
      [{ sheet: sheet([["2026-08-10", "Carnê loja (2/5)", "-100", "itau", "", "Pago"], ["2026-09-10", "Carnê loja (3/5)", "-100", "itau", "", "Pago"], ["2026-11-20", "IPTU", "-300", "itau", "", "A pagar"]]), cfg }],
      res,
      { fileName: "f.xlsx", today: "2026-10-19", defaultAccountId: null, defaultCardId: null, contextYear: 2026 },
    );
    expect(out.rows).toHaveLength(2);
    expect(out.bills.find((b) => b.origin === "TO_PAY")).toMatchObject({ description: "IPTU", dueDate: "2026-11-20", amountCents: 30_000, accountId: "acc-itau", type: "EXPENSE" });
    expect(out.bills.filter((b) => b.origin === "FUTURE_INSTALLMENT").map((b) => [b.description, b.dueDate])).toEqual([["Carnê loja (parcela 5/5)", "2026-11-10"]]);
  });

  it("valores sem sinal: o tipo da categoria decide; crédito sem cartão vai para o cartão padrão", () => {
    const res = emptyRes();
    res.category.set("salario", { categoryId: "inc", subcategoryId: null, kind: "INCOME" });
    res.category.set("mercado", { categoryId: "exp", subcategoryId: null, kind: "EXPENSE" });
    const h = ["Data", "Descrição", "Valor", "Categoria", "Forma"];
    const unsigned = listConfig(h, { date: 0, description: 1, amount: 2, category: 3, paymentMethod: 4 }, { unsigned: true, unsignedAs: "BY_CATEGORY" });
    const raw: RawSheet = { name: "Lista", hidden: false, rows: [h, ["2025-01-05", "Salário", "5000", "Salario", "Pix"], ["2025-01-06", "Compra", "80", "Mercado", "Crédito"], ["2025-01-07", "Sem categoria", "10", "", "Pix"]], rowNumbers: [1, 2, 3, 4], truncated: false };
    const out = buildMigrationRows([{ sheet: raw, cfg: unsigned }], res, { fileName: "f.xlsx", today: "2026-10-19", defaultAccountId: "acc-itau", defaultCardId: "card-nu", contextYear: 2025 });
    expect(out.rows.map((r) => [r.parsed.amountCents, r.dest, r.parsed.meta.categoryId])).toEqual([
      [500_000, "A:acc-itau", "inc"],
      [-8_000, "C:card-nu", "exp"],
      [-1_000, "A:acc-itau", null],
    ]);
    expect(out.warnings[0]).toMatch(/sem sinal e sem categoria entraram como despesa/);
  });
});

describe("formato lembrado", () => {
  it("assinatura pelos cabeçalhos; colunas pelo nome mesmo se mudarem de posição", () => {
    const a = listConfig(["Data", "Descrição", "Valor", "Categoria"], { date: 0, description: 1, amount: 2, category: 3 });
    a.signature = sheetSignature(a);
    const b = listConfig(["Categoria", "Valor", "Data", "Descrição"], { date: 2, description: 3, amount: 1, category: 0 });
    b.signature = sheetSignature(b);
    expect(a.signature).toBe(b.signature);
    const config = buildTemplateConfig([{ ...a, unsignedAs: null }], [], { defaultAccountId: null, defaultCardId: null });
    const applied = applyTemplateToSheets(config, [{ ...b, columns: { ...b.columns, category: null } }]);
    expect(applied[0]!.columns).toMatchObject({ date: 2, description: 3, amount: 1, category: 0 });
    expect(applied[0]!.fromTemplate).toBe(true);
  });
});

import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { formatDateBR } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { recognizedRows, resolveRegime, type AnalyticsFilters } from "../analytics/service";
import { audit } from "../audit/service";
import { renderCustomReportPdf } from "./pdf";
import { renderTransactionsXlsx } from "./xlsx";
import type { ExportTransactionRow } from "./csv";

/**
 * Relatório sob encomenda (pedido à Isa): "pdf dos gastos de junho", "excel só dos gastos no pix
 * desse mês", "receitas do trimestre por categoria". Período e filtros livres, com os mesmos
 * números do painel (compra parcelada conta a parcela do período; repasses ficam de fora).
 */

export interface CustomReportInput {
  start: string;
  end: string;
  kind: "EXPENSE" | "INCOME" | "ALL";
  format: "pdf" | "xlsx";
  filters: AnalyticsFilters;
  /** Descrição dos filtros para o título ("no Pix", "em Alimentação"). */
  filterLabel?: string;
}

export interface CustomReportFile {
  content: Buffer;
  fileName: string;
  mimeType: string;
  count: number;
  totalCents: number;
  title: string;
}

const KIND_TITLE = { EXPENSE: "Gastos", INCOME: "Receitas", ALL: "Receitas e gastos" } as const;

export async function buildCustomReport(ctx: ServiceContext, input: CustomReportInput): Promise<CustomReportFile> {
  assertCan(ctx, "reports:read");
  const regime = await resolveRegime(ctx);
  const rows = (await recognizedRows(ctx, { start: input.start, end: input.end }, regime, input.filters)).filter((r) => input.kind === "ALL" || r.type === input.kind);
  rows.sort((a, b) => a.date.localeCompare(b.date) || b.amountCents - a.amountCents);

  const [categories, accounts, cards, household] = await Promise.all([
    prisma.category.findMany({ where: { householdId: ctx.householdId }, select: { id: true, name: true } }),
    prisma.account.findMany({ where: { householdId: ctx.householdId }, select: { id: true, name: true } }),
    prisma.creditCard.findMany({ where: { householdId: ctx.householdId }, select: { id: true, name: true } }),
    prisma.household.findUniqueOrThrow({ where: { id: ctx.householdId }, select: { name: true } }),
  ]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const whereName = (r: (typeof rows)[number]) => (r.creditCardId ? cards.find((c) => c.id === r.creditCardId)?.name : accounts.find((a) => a.id === r.accountId)?.name) ?? "";
  const sign = (r: (typeof rows)[number]) => (r.type === "INCOME" ? 1 : -1);

  const expense = rows.filter((r) => r.type === "EXPENSE").reduce((s, r) => s + r.amountCents, 0);
  const income = rows.filter((r) => r.type === "INCOME").reduce((s, r) => s + r.amountCents, 0);
  const totalCents = input.kind === "INCOME" ? income : input.kind === "EXPENSE" ? expense : income - expense;

  const byCat = new Map<string, number>();
  for (const r of rows.filter((x) => input.kind !== "ALL" || x.type === "EXPENSE")) {
    const key = r.categoryId ? catName.get(r.categoryId) ?? "Sem categoria" : "Sem categoria";
    byCat.set(key, (byCat.get(key) ?? 0) + r.amountCents);
  }
  const catTotal = [...byCat.values()].reduce((s, v) => s + v, 0) || 1;
  const byCategory = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([label, valueCents]) => ({ label, valueCents, percent: (valueCents / catTotal) * 100 }));

  const periodLabel = `${formatDateBR(input.start)} a ${formatDateBR(input.end)}`;
  const title = `${KIND_TITLE[input.kind]}${input.filterLabel ? ` ${input.filterLabel}` : ""}`;
  const stamp = `${input.start}_${input.end}`;
  const label = (r: (typeof rows)[number]) => (r.installmentNumber ? `${r.description} (parcela ${r.installmentNumber}/${r.installmentCount})` : r.description);

  let content: Buffer;
  if (input.format === "pdf") {
    content = await renderCustomReportPdf({
      title,
      subtitle: `${household.name} · ${periodLabel} · regime de ${regime === "CASH" ? "caixa" : "competência"}`,
      householdName: household.name,
      timezone: ctx.timezone,
      generatedAt: new Date().toISOString(),
      totals:
        input.kind === "ALL"
          ? [
              { label: "Receitas", value: formatBRL(income), color: "#047857" },
              { label: "Gastos", value: formatBRL(expense), color: "#b91c1c" },
              { label: "Resultado", value: formatBRL(income - expense) },
            ]
          : [
              { label: `Total de ${KIND_TITLE[input.kind].toLowerCase()}`, value: formatBRL(totalCents), color: input.kind === "INCOME" ? "#047857" : "#b91c1c" },
              { label: "Lançamentos", value: String(rows.length) },
            ],
      byCategory,
      rows: rows.slice(0, 600).map((r) => ({ date: r.date, description: label(r), category: r.categoryId ? catName.get(r.categoryId) ?? "Sem categoria" : "Sem categoria", where: whereName(r), amountCents: sign(r) * r.amountCents })),
      notes: [
        "Compras parceladas no cartão entram pela parcela do período. Repasses e lançamentos desconsiderados ficam de fora.",
        ...(rows.length > 600 ? [`Mostrando os primeiros 600 de ${rows.length} lançamentos; a planilha traz todos.`] : []),
      ],
    });
  } else {
    const xrows: ExportTransactionRow[] = rows.map((r) => ({
      id: r.transactionId,
      date: r.date,
      description: label(r),
      category: r.categoryId ? catName.get(r.categoryId) ?? "" : "",
      subcategory: "",
      type: r.type,
      typeLabel: r.type === "INCOME" ? "Receita" : "Despesa",
      signedAmountCents: sign(r) * r.amountCents,
      paymentMethod: r.paymentMethod ? PAYMENT_METHOD_LABELS[r.paymentMethod as keyof typeof PAYMENT_METHOD_LABELS] ?? r.paymentMethod : "",
      accountOrCard: whereName(r),
      responsible: "",
      status: "Confirmado",
      installmentCount: r.installmentCount,
      deleted: false,
      nature: "",
    }));
    content = await renderTransactionsXlsx(xrows, { title: `${title} · ${periodLabel}` });
  }
  await audit(ctx, { action: "EXPORT", entityType: "Transaction", metadata: { custom: true, format: input.format, kind: input.kind, start: input.start, end: input.end, rows: rows.length } });
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    content,
    fileName: `${slug}_${stamp}.${input.format}`,
    mimeType: input.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    count: rows.length,
    totalCents,
    title: `${title} · ${periodLabel}`,
  };
}

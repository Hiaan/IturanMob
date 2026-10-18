import { z } from "zod";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import {
  addDays,
  addMonths,
  dateToISO,
  endOfMonth,
  isISODate,
  isMonthKey,
  isoToDate,
  monthKey,
  monthRange,
  resolvePeriod,
  startOfMonth,
  todayISO,
  type Period,
  type PeriodPreset,
} from "@/lib/dates";
import { formatBRL, formatMoney, percentChange } from "@/lib/money";
import { normalizeText } from "@/lib/utils";
import { budgetOverview, cashflowProjection, compareCategories, expensesByCategory, expensesByPerson, recognizedRows, resolveScope, topExpenses } from "../../modules/analytics/service";
import { listAccounts } from "../../modules/accounts/service";
import { listCards, listStatements } from "../../modules/cards/service";
import { listTransactions } from "../../modules/transactions/service";
import { closeObjects } from "../engine/schemas";

/**
 * Ferramentas do assistente: SOMENTE LEITURA, com parâmetros validados por Zod e
 * sempre restritas à família do contexto. O modelo nunca executa SQL nem altera dados.
 * Cada resultado informa a natureza do dado: CONFIRMADO, ESTIMADO ou PROJEÇÃO.
 */

const periodSchema = z
  .object({
    preset: z
      .enum(["today", "yesterday", "last7", "last30", "thisWeek", "thisMonth", "lastMonth", "last3Months", "last6Months", "last12Months", "thisYear", "lastYear"])
      .nullable()
      .describe("Período pré-definido."),
    month: z.string().nullable().describe("Mês específico no formato AAAA-MM."),
    start: z.string().nullable().describe("Data inicial AAAA-MM-DD (com end)."),
    end: z.string().nullable().describe("Data final AAAA-MM-DD (com start)."),
  })
  .describe("Período da consulta. Informe preset OU month OU start/end.");

type PeriodInput = z.infer<typeof periodSchema>;

export function periodFrom(p: PeriodInput | null | undefined, ctx: ServiceContext): Period {
  const today = todayISO(ctx.timezone);
  if (p?.month && isMonthKey(p.month)) return monthRange(p.month);
  if (p?.start && p?.end && isISODate(p.start) && isISODate(p.end)) return p.start <= p.end ? { start: p.start, end: p.end } : { start: p.end, end: p.start };
  return resolvePeriod((p?.preset ?? "thisMonth") as PeriodPreset, today);
}

async function categoryIdsByName(ctx: ServiceContext, name: string | null | undefined): Promise<{ ids: string[]; subId: string | null; label: string } | null> {
  if (!name) return null;
  const n = normalizeText(name);
  const cats = await prisma.category.findMany({ where: { householdId: ctx.householdId }, include: { subcategories: true } });
  const cat = cats.find((c) => normalizeText(c.name) === n);
  if (cat) return { ids: [cat.id], subId: null, label: cat.name };
  for (const c of cats) {
    const sub = c.subcategories.find((s) => normalizeText(s.name) === n || s.keywords.includes(n));
    if (sub) return { ids: [c.id], subId: sub.id, label: `${c.name} › ${sub.name}` };
  }
  const partial = cats.find((c) => normalizeText(c.name).includes(n) || n.includes(normalizeText(c.name)));
  return partial ? { ids: [partial.id], subId: null, label: partial.name } : null;
}

async function memberIdByName(ctx: ServiceContext, name: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!name) return null;
  const n = normalizeText(name);
  const members = await prisma.householdMember.findMany({ where: { householdId: ctx.householdId } });
  const m = members.find((x) => normalizeText(x.displayName) === n || normalizeText(x.displayName).split(" ")[0] === n || (x.relation && normalizeText(x.relation) === n));
  return m ? { id: m.id, name: m.displayName } : null;
}

const fmt = (cents: number) => formatBRL(cents);

export interface AssistantTool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (ctx: ServiceContext, input: z.output<S>) => Promise<unknown>;
}

function tool<S extends z.ZodType>(t: AssistantTool<S>): AssistantTool<S> {
  return t;
}

export const ASSISTANT_TOOLS = [
  tool({
    name: "resumo_periodo",
    description: "Receitas, despesas e resultado de um período (dados confirmados), com as principais categorias e comparação com o período anterior.",
    schema: z.object({ period: periodSchema, regime: z.enum(["ACCRUAL", "CASH"]).nullable().describe("Competência (padrão) ou caixa.") }),
    run: async (ctx, input) => {
      const period = periodFrom(input.period, ctx);
      const regime = input.regime ?? undefined;
      const rows = await recognizedRows(ctx, period, regime ?? "ACCRUAL");
      const income = rows.filter((r) => r.type === "INCOME").reduce((s, r) => s + r.amountCents, 0);
      const expense = rows.filter((r) => r.type === "EXPENSE").reduce((s, r) => s + r.amountCents, 0);
      const cats = await expensesByCategory(ctx, { period, regime });
      const cmp = await compareCategories(ctx, { current: period, regime });
      return {
        basis: "CONFIRMADO",
        period,
        regime: regime ?? "ACCRUAL",
        income: fmt(income),
        expense: fmt(expense),
        result: fmt(income - expense),
        transactionsCount: rows.length,
        topCategories: cats.items.slice(0, 6).map((c) => ({ name: c.name, amount: fmt(c.amountCents), percent: c.percent })),
        previousPeriod: cmp.previous,
        previousExpense: fmt(cmp.totalPreviousCents),
        expenseChangePct: cmp.totalChangePct,
      };
    },
  }),
  tool({
    name: "buscar_transacoes",
    description: "Lista transações confirmadas com filtros (período, tipo, categoria, pessoa, valor mínimo/máximo, texto, forma de pagamento). Retorna no máximo 25 itens e o total somado.",
    schema: z.object({
      period: periodSchema.nullable(),
      type: z.enum(["EXPENSE", "INCOME"]).nullable(),
      category: z.string().nullable().describe("Nome da categoria ou subcategoria."),
      person: z.string().nullable().describe("Nome ou parentesco do membro (ex.: 'esposa')."),
      minAmount: z.number().nullable().describe("Valor mínimo em reais."),
      maxAmount: z.number().nullable().describe("Valor máximo em reais."),
      text: z.string().nullable().describe("Texto na descrição ou estabelecimento."),
      paymentMethod: z.enum(["PIX", "DEBIT_CARD", "CREDIT_CARD", "CASH", "BANK_SLIP", "BANK_TRANSFER", "AUTO_DEBIT", "VOUCHER", "OTHER"]).nullable(),
      sort: z.enum(["date_desc", "amount_desc"]).nullable(),
      limit: z.number().int().nullable(),
    }),
    run: async (ctx, input) => {
      const period = input.period ? periodFrom(input.period, ctx) : null;
      const cat = await categoryIdsByName(ctx, input.category);
      const member = await memberIdByName(ctx, input.person);
      if (input.category && !cat) return { basis: "CONFIRMADO", error: `Categoria "${input.category}" não encontrada.` };
      if (input.person && !member) return { basis: "CONFIRMADO", error: `Pessoa "${input.person}" não encontrada.` };
      // Mesmo recorte dos relatórios: Pessoa física / Empresa / Tudo; repasses ficam de fora.
      const nature = await resolveScope(ctx);
      const res = await listTransactions(ctx, {
        ...(nature === "ALL" ? {} : { scope: nature }),
        excluded: "hide",
        start: period?.start,
        end: period?.end,
        types: input.type ? [input.type] : ["EXPENSE", "INCOME"],
        status: "CONFIRMED",
        categoryIds: cat?.ids,
        subcategoryId: cat?.subId ?? undefined,
        memberId: member?.id,
        minAmountCents: input.minAmount != null ? Math.round(input.minAmount * 100) : undefined,
        maxAmountCents: input.maxAmount != null ? Math.round(input.maxAmount * 100) : undefined,
        search: input.text ?? undefined,
        paymentMethods: input.paymentMethod ? [input.paymentMethod] : undefined,
        sort: input.sort ?? "date_desc",
        pageSize: Math.min(Math.max(input.limit ?? 15, 1), 25),
      });
      return {
        basis: "CONFIRMADO",
        period,
        filters: { category: cat?.label ?? null, person: member?.name ?? null },
        totalCount: res.total,
        totalExpense: fmt(res.totals.expenseCents),
        totalIncome: fmt(res.totals.incomeCents),
        items: res.items.map((t) => ({
          date: t.date,
          description: t.description,
          amount: fmt(t.amountCents),
          type: t.type,
          category: t.subcategory ? `${t.category?.name} › ${t.subcategory.name}` : t.category?.name ?? "Sem categoria",
          payer: t.payer?.displayName ?? null,
          installments: t.installmentCount,
        })),
      };
    },
  }),
  tool({
    name: "gastos_por_categoria",
    description: "Despesas (ou receitas) agrupadas por categoria no período, opcionalmente de uma pessoa.",
    schema: z.object({ period: periodSchema, type: z.enum(["EXPENSE", "INCOME"]).nullable(), person: z.string().nullable() }),
    run: async (ctx, input) => {
      const period = periodFrom(input.period, ctx);
      const member = await memberIdByName(ctx, input.person);
      const res = await expensesByCategory(ctx, { period, type: input.type ?? "EXPENSE", filters: { memberId: member?.id } });
      return { basis: "CONFIRMADO", period, person: member?.name ?? null, total: fmt(res.totalCents), items: res.items.map((i) => ({ name: i.name, amount: fmt(i.amountCents), percent: i.percent })) };
    },
  }),
  tool({
    name: "comparar_periodos",
    description: "Compara despesas por categoria entre dois períodos (ex.: agosto x setembro), com variação percentual e a origem do cálculo.",
    schema: z.object({ current: periodSchema, previous: periodSchema.nullable(), category: z.string().nullable() }),
    run: async (ctx, input) => {
      const current = periodFrom(input.current, ctx);
      const previous = input.previous ? periodFrom(input.previous, ctx) : undefined;
      const res = await compareCategories(ctx, { current, previous });
      const cat = input.category ? normalizeText(input.category) : null;
      const items = cat ? res.items.filter((i) => normalizeText(i.name).includes(cat)) : res.items.slice(0, 10);
      return {
        basis: "CONFIRMADO",
        current: res.current,
        previous: res.previous,
        totalCurrent: fmt(res.totalCurrentCents),
        totalPrevious: fmt(res.totalPreviousCents),
        totalChangePct: res.totalChangePct,
        items: items.map((i) => ({ name: i.name, current: fmt(i.currentCents), previous: fmt(i.previousCents), changePct: i.changePct })),
        method: res.method,
      };
    },
  }),
  tool({
    name: "maiores_despesas",
    description: "Maiores despesas do período (por valor reconhecido).",
    schema: z.object({ period: periodSchema, limit: z.number().int().nullable() }),
    run: async (ctx, input) => {
      const period = periodFrom(input.period, ctx);
      const res = await topExpenses(ctx, { period, limit: Math.min(Math.max(input.limit ?? 5, 1), 20) });
      return { basis: "CONFIRMADO", period, items: res.items.map((i) => ({ date: i.date, description: i.description, amount: fmt(i.amountCents), category: i.category?.name ?? "Sem categoria" })) };
    },
  }),
  tool({
    name: "status_orcamento",
    description: "Orçamento do mês por categoria: limite, utilizado, restante e projeção até o fim do mês (projeção é ESTIMADA).",
    schema: z.object({ month: z.string().nullable().describe("AAAA-MM; padrão: mês atual."), category: z.string().nullable() }),
    run: async (ctx, input) => {
      const month = input.month && isMonthKey(input.month) ? input.month : monthKey(todayISO(ctx.timezone));
      const res = await budgetOverview(ctx, month);
      const cat = input.category ? normalizeText(input.category) : null;
      const items = cat ? res.items.filter((i) => normalizeText(i.category.name).includes(cat)) : res.items;
      return {
        basis: "CONFIRMADO (utilizado) / ESTIMADO (projeção)",
        month,
        hasBudgets: res.items.length > 0,
        items: items.map((i) => ({ category: i.category.name, limit: fmt(i.limitCents), spent: fmt(i.spentCents), remaining: fmt(i.remainingCents), percentUsed: i.percentUsed, projectedMonthEnd: fmt(i.projectedCents) })),
        totalLimit: fmt(res.totalLimitCents),
        totalSpent: fmt(res.totalSpentCents),
      };
    },
  }),
  tool({
    name: "contas_a_pagar",
    description: "Contas previstas pendentes (inclui vencidas) e faturas de cartão em aberto nos próximos dias.",
    schema: z.object({ days: z.number().int().nullable().describe("Horizonte em dias (padrão 30).") }),
    run: async (ctx, input) => {
      const today = todayISO(ctx.timezone);
      const until = addDays(today, Math.min(Math.max(input.days ?? 30, 1), 365));
      const bills = await prisma.scheduledPayment.findMany({
        where: { householdId: ctx.householdId, type: "EXPENSE", status: "PENDING", dueDate: { lte: isoToDate(until) } },
        orderBy: { dueDate: "asc" },
        take: 50,
      });
      const cards = await listCards(ctx);
      const statements: Array<{ card: string; referenceMonth: string; dueDate: string; remaining: string; remainingCents: number }> = [];
      for (const c of cards) {
        for (const s of await listStatements(ctx, c.id)) {
          if (s.remainingCents > 0 && s.dueDate <= until && s.closingDate <= today) statements.push({ card: c.name, referenceMonth: s.referenceMonth, dueDate: s.dueDate, remaining: fmt(s.remainingCents), remainingCents: s.remainingCents });
        }
      }
      const billsTotal = bills.reduce((s, b) => s + b.amountCents, 0);
      const stTotal = statements.reduce((s, x) => s + x.remainingCents, 0);
      return {
        basis: "CONFIRMADO (contas cadastradas); valores variáveis são ESTIMADOS",
        until,
        bills: bills.map((b) => ({ description: b.description, dueDate: dateToISO(b.dueDate), amount: fmt(b.amountCents), overdue: dateToISO(b.dueDate) < today, estimate: b.isEstimate })),
        cardStatements: statements.map(({ remainingCents: _r, ...s }) => s),
        total: fmt(billsTotal + stTotal),
      };
    },
  }),
  tool({
    name: "faturas_cartao",
    description: "Situação dos cartões: fatura atual, próximas faturas e limite disponível.",
    schema: z.object({ card: z.string().nullable() }),
    run: async (ctx, input) => {
      const cards = await listCards(ctx);
      const filtered = input.card ? cards.filter((c) => normalizeText(c.name).includes(normalizeText(input.card!))) : cards;
      const out = [];
      for (const c of filtered) {
        const st = await listStatements(ctx, c.id);
        out.push({
          card: c.name,
          limit: fmt(c.limitCents),
          available: c.availableLimitCents === null ? null : fmt(c.availableLimitCents),
          outstanding: fmt(c.outstandingCents),
          statements: st.slice(0, 6).map((s) => ({ referenceMonth: s.referenceMonth, dueDate: s.dueDate, total: fmt(s.totalCents), remaining: fmt(s.remainingCents), status: s.status })),
        });
      }
      return { basis: "CONFIRMADO", cards: out };
    },
  }),
  tool({
    name: "metas",
    description: "Progresso das metas financeiras.",
    schema: z.object({}),
    run: async (ctx) => {
      const goals = await prisma.financialGoal.findMany({ where: { householdId: ctx.householdId, status: { not: "ARCHIVED" } }, include: { contributions: { where: { deletedAt: null }, select: { amountCents: true } } } });
      return {
        basis: "CONFIRMADO",
        goals: goals.map((g) => {
          const acc = g.contributions.reduce((s, c) => s + c.amountCents, 0);
          return { name: g.name, target: fmt(g.targetCents), accumulated: fmt(acc), percent: Math.round((acc / g.targetCents) * 1000) / 10, deadline: g.deadline ? dateToISO(g.deadline) : null, status: g.status };
        }),
      };
    },
  }),
  tool({
    name: "recorrencias",
    description: "Despesas/receitas recorrentes ativas (ex.: assinaturas, aluguel).",
    schema: z.object({ onlySubscriptions: z.boolean().nullable() }),
    run: async (ctx, input) => {
      const rec = await prisma.recurringTransaction.findMany({
        where: { householdId: ctx.householdId, active: true, ...(input.onlySubscriptions ? { category: { name: "Assinaturas" } } : {}) },
        include: { category: { select: { name: true } }, subcategory: { select: { name: true } } },
        orderBy: { amountCents: "desc" },
      });
      return {
        basis: "CONFIRMADO (cadastro); valores variáveis são ESTIMADOS",
        items: rec.map((r) => ({ description: r.description, amount: fmt(r.amountCents), frequency: r.frequency, category: r.subcategory?.name ?? r.category?.name ?? null, variable: r.isVariableAmount })),
      };
    },
  }),
  tool({
    name: "saldos",
    description: "Saldo atual de cada conta e total disponível.",
    schema: z.object({}),
    run: async (ctx) => {
      const accounts = await listAccounts(ctx);
      return {
        basis: "CONFIRMADO",
        accounts: accounts.map((a) => ({
          name: a.name,
          balance: a.currency === "BRL" ? fmt(a.balanceCents) : `${formatMoney(a.balanceCents, a.currency)}${a.balanceBrlCents !== null && a.fx ? ` (≈ ${fmt(a.balanceBrlCents)} pela PTAX de ${a.fx.date})` : ""}`,
          type: a.type,
        })),
        total: fmt(accounts.filter((a) => a.includeInTotals).reduce((s, a) => s + (a.balanceBrlCents ?? 0), 0)),
      };
    },
  }),
  tool({
    name: "media_gastos",
    description: "Média mensal de despesas (total ou de uma categoria) nos últimos N meses completos.",
    schema: z.object({ category: z.string().nullable(), months: z.number().int().nullable() }),
    run: async (ctx, input) => {
      const months = Math.min(Math.max(input.months ?? 3, 1), 24);
      const today = todayISO(ctx.timezone);
      const end = endOfMonth(addMonths(startOfMonth(today), -1));
      const start = addMonths(startOfMonth(today), -months);
      const cat = await categoryIdsByName(ctx, input.category);
      if (input.category && !cat) return { error: `Categoria "${input.category}" não encontrada.` };
      const rows = (await recognizedRows(ctx, { start, end }, "ACCRUAL", { categoryIds: cat?.ids })).filter((r) => r.type === "EXPENSE" && (!cat?.subId || r.subcategoryId === cat.subId));
      const total = rows.reduce((s, r) => s + r.amountCents, 0);
      return { basis: "CONFIRMADO", period: { start, end }, months, category: cat?.label ?? "todas", total: fmt(total), monthlyAverage: fmt(Math.round(total / months)), transactions: rows.length };
    },
  }),
  tool({
    name: "ritmo_do_mes",
    description: "Projeção (ESTIMADA) do gasto até o fim do mês mantendo o ritmo atual e quanto ainda cabe no orçamento.",
    schema: z.object({ category: z.string().nullable() }),
    run: async (ctx, input) => {
      const today = todayISO(ctx.timezone);
      const start = startOfMonth(today);
      const end = endOfMonth(today);
      const cat = await categoryIdsByName(ctx, input.category);
      const rows = (await recognizedRows(ctx, { start, end: today }, "ACCRUAL", { categoryIds: cat?.ids })).filter((r) => r.type === "EXPENSE");
      const spent = rows.reduce((s, r) => s + r.amountCents, 0);
      const day = Number(today.slice(8, 10));
      const days = Number(end.slice(8, 10));
      const projected = day > 0 ? Math.round((spent / day) * days) : spent;
      const budget = await budgetOverview(ctx, monthKey(today));
      const b = cat ? budget.items.find((i) => cat.ids.includes(i.category.id)) : null;
      const limit = cat ? b?.limitCents ?? null : budget.totalLimitCents || null;
      return {
        basis: "PROJEÇÃO (ritmo linear dos gastos já confirmados)",
        category: cat?.label ?? "todas",
        spentSoFar: fmt(spent),
        daysElapsed: day,
        daysInMonth: days,
        projectedMonthTotal: fmt(projected),
        budgetLimit: limit !== null ? fmt(limit) : null,
        remainingBudget: limit !== null ? fmt(limit - spent) : null,
        dailyAllowanceToStayInBudget: limit !== null && days - day > 0 ? fmt(Math.max(0, Math.floor((limit - spent) / (days - day)))) : null,
      };
    },
  }),
  tool({
    name: "projecao_fluxo_caixa",
    description: "Projeção (ESTIMADA) do saldo disponível nos próximos dias, com hipóteses e grau de incerteza.",
    schema: z.object({ days: z.number().int().nullable() }),
    run: async (ctx, input) => {
      const res = await cashflowProjection(ctx, Math.min(Math.max(input.days ?? 30, 7), 365));
      return {
        basis: "PROJEÇÃO",
        start: res.startDate,
        end: res.endDate,
        startBalance: fmt(res.startBalanceCents),
        endBalance: fmt(res.endBalanceCents),
        lowestPoint: { date: res.lowestPoint.date, balance: fmt(res.lowestPoint.balanceCents) },
        upcoming: res.events.slice(0, 15).map((e) => ({ date: e.date, description: e.description, amount: fmt(e.amountCents), certainty: e.certainty })),
        assumptions: res.assumptions,
        uncertainty: res.uncertainty,
      };
    },
  }),
  tool({
    name: "gastos_por_pessoa",
    description: "Despesas por pessoa (responsabilidade econômica e quem pagou) no período.",
    schema: z.object({ period: periodSchema }),
    run: async (ctx, input) => {
      const period = periodFrom(input.period, ctx);
      const res = await expensesByPerson(ctx, { period });
      return {
        basis: "CONFIRMADO",
        period,
        total: fmt(res.totalCents),
        byResponsibility: res.byResponsibility.map((i) => ({ name: i.name, amount: fmt(i.amountCents), percent: i.percent })),
        byPayer: res.byPayer.map((i) => ({ name: i.name, amount: fmt(i.amountCents), percent: i.percent })),
      };
    },
  }),
];

export function toolDefinitions() {
  return ASSISTANT_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: closeObjects(z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>) }));
}

/** Executa uma ferramenta validando a entrada (entradas inválidas são rejeitadas). */
export async function runTool(ctx: ServiceContext, name: string, input: unknown): Promise<unknown> {
  const t = ASSISTANT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Ferramenta desconhecida: ${name}`);
  const parsed = (t.schema as z.ZodType).safeParse(input ?? {});
  if (!parsed.success) throw new Error(`Parâmetros inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return (t.run as (c: ServiceContext, i: unknown) => Promise<unknown>)(ctx, parsed.data);
}

export { percentChange };

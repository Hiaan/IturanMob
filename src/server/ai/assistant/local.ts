import type { ServiceContext } from "../../auth/context";
import { addMonths, describePeriod, endOfMonth, formatMonthBR, monthKey, startOfMonth, todayISO, type Period } from "@/lib/dates";
import { normalizeForNlu } from "../nlu/text";
import { extractAmounts, spelledToNumber } from "../nlu/numbers";
import { extractPeriods, defaultMonthPeriod } from "../nlu/dates";
import { findPerson, matchCategory } from "../nlu/local-parser";
import { loadHouseholdContext } from "../engine/context";
import { runTool } from "./tools";
import { resolveScope } from "../../modules/analytics/service";

/**
 * Assistente local (determinístico): responde às perguntas mais comuns usando apenas
 * as ferramentas somente-leitura. Nunca estima sem dizer que é estimativa.
 */
export interface LocalAnswer {
  text: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  understood: boolean;
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NUMBER_WORDS: Record<string, number> = { tres: 3, cinco: 5, dez: 10, quatro: 4, seis: 6, sete: 7, oito: 8, nove: 9, duas: 2, dois: 2 };

function periodInput(p: Period) {
  return { preset: null, month: null, start: p.start, end: p.end };
}

const FOOT_CONFIRMED = "_Fonte: lançamentos confirmados._";

/** "este mês" → "neste mês"; "setembro de 2026" → "em setembro de 2026". */
export function inPeriod(label: string): string {
  if (/^est[ea] /.test(label)) return label.replace(/^est(e|a) /, "nest$1 ");
  if (/^o /.test(label)) return label.replace(/^o /, "no ");
  if (/^(hoje|ontem)$/.test(label)) return label;
  if (/^últim[oa]s /.test(label)) return `n${label.startsWith("últimas") ? "as" : "os"} ${label}`;
  return `em ${label}`;
}

/** "este mês" → "deste mês"; "setembro de 2026" → "de setembro de 2026". */
export function ofPeriod(label: string): string {
  if (/^est[ea] /.test(label)) return label.replace(/^est(e|a) /, "dest$1 ");
  if (/^o /.test(label)) return label.replace(/^o /, "do ");
  if (/^(hoje|ontem)$/.test(label)) return `de ${label}`;
  if (/^últim[oa]s /.test(label)) return `d${label.startsWith("últimas") ? "as" : "os"} ${label}`;
  return `de ${label}`;
}

export async function answerLocally(ctx: ServiceContext, question: string): Promise<LocalAnswer> {
  const hc = await loadHouseholdContext(ctx);
  const today = todayISO(ctx.timezone);
  const q = normalizeForNlu(question);
  const periods = extractPeriods(question, today);
  const period = (periods[0] ?? defaultMonthPeriod(today)).period;
  const periodLabel = periods[0]?.label ?? "este mês";
  const calls: Array<{ name: string; input: unknown }> = [];
  const call = async (name: string, input: unknown): Promise<Any> => {
    calls.push({ name, input });
    return (await runTool(ctx, name, input)) as Any;
  };

  const isIncome = /\b(recebemos|recebi|recebeu|receita|receitas|entrou|ganhamos|ganhei)\b/.test(q);
  const category = matchCategory(q, hc, isIncome ? "INCOME" : "EXPENSE");
  const categoryName = category ? category.label.split(" > ").pop()! : null;
  const person = /\b(eu|gastei)\b/.test(q) && hc.sender ? { name: hc.sender.displayName } : (() => {
    const p = findPerson(q, hc);
    return p ? { name: hc.members.find((m) => m.id === p.memberId)!.displayName } : null;
  })();

  // 1. Comparação de períodos
  if (/\bcompar/.test(q)) {
    const current = periods[1]?.period ?? periods[0]?.period ?? defaultMonthPeriod(today).period;
    const previous = periods.length >= 2 ? periods[0]!.period : undefined;
    const r = await call("comparar_periodos", { current: periodInput(current), previous: previous ? periodInput(previous) : null, category: categoryName });
    const lines = (r.items as Any[]).slice(0, 6).map((i) => `• ${i.name}: ${i.previous} → ${i.current}${i.changePct !== null ? ` (${i.changePct > 0 ? "+" : ""}${i.changePct}%)` : ""}`);
    return {
      understood: true,
      toolCalls: calls,
      text: `Comparando ${describePeriod(r.previous)} com ${describePeriod(r.current)}:\nTotal de despesas: ${r.totalPrevious} → *${r.totalCurrent}*${r.totalChangePct !== null ? ` (${r.totalChangePct > 0 ? "+" : ""}${r.totalChangePct}%)` : ""}\n${lines.join("\n")}\n_${r.method}_`,
    };
  }

  // 2. Maiores despesas
  if (/\bmaior(es)?\s+(despesa|despesas|gasto|gastos|compra|compras)\b/.test(q)) {
    const nMatch = /\b(\d{1,2}|tres|cinco|dez|quatro|seis|sete|oito|nove|duas|dois)\s+maior/.exec(q);
    const n = nMatch ? (/^\d+$/.test(nMatch[1]!) ? Number(nMatch[1]) : NUMBER_WORDS[nMatch[1]!] ?? 5) : /\bmaior (despesa|gasto|compra)\b/.test(q) ? 1 : 5;
    const r = await call("maiores_despesas", { period: periodInput(period), limit: n });
    const items = r.items as Any[];
    if (!items.length) return { understood: true, toolCalls: calls, text: `Não há despesas confirmadas ${inPeriod(periodLabel)}.` };
    if (n === 1) return { understood: true, toolCalls: calls, text: `A maior despesa ${ofPeriod(periodLabel)} foi *${items[0]!.description}* — ${items[0]!.amount} (${items[0]!.category}, ${items[0]!.date.split("-").reverse().join("/")}).\n${FOOT_CONFIRMED}` };
    return { understood: true, toolCalls: calls, text: `As ${items.length} maiores despesas ${ofPeriod(periodLabel)}:\n${items.map((i, k) => `${k + 1}. ${i.description} — ${i.amount} (${i.category})`).join("\n")}\n${FOOT_CONFIRMED}` };
  }

  // 3. Contas a pagar / não pagas / próximo mês
  if (/\b(contas? (a|para|pra) pagar|falta pagar|nao (foram )?pag|ainda nao pag|vencid|a vencer|boleto|teremos (para|pra) pagar|temos (para|pra) pagar|temos de contas)\b/.test(q)) {
    const nextMonth = /\bproximo mes\b/.test(q);
    const r = await call("contas_a_pagar", { days: nextMonth ? 70 : 30 });
    let bills = r.bills as Any[];
    let statements = r.cardStatements as Any[];
    if (nextMonth) {
      const nm = monthKey(addMonths(startOfMonth(today), 1));
      bills = bills.filter((b) => String(b.dueDate).startsWith(nm));
      statements = statements.filter((s) => String(s.dueDate).startsWith(nm));
    }
    if (!bills.length && !statements.length) return { understood: true, toolCalls: calls, text: nextMonth ? "Não há contas previstas nem faturas registradas para o próximo mês." : "Não há contas pendentes nos próximos 30 dias. 🎉" };
    const parse = (s: string) => Number(s.replace(/[^\d,-]/g, "").replace(",", "."));
    const total = [...bills.map((b) => parse(b.amount)), ...statements.map((s) => parse(s.remaining))].reduce((a, b) => a + b, 0);
    const lines = [
      ...bills.map((b) => `• ${b.description} — ${b.amount} (vence ${String(b.dueDate).split("-").reverse().join("/")})${b.overdue ? " ⚠️ vencida" : ""}${b.estimate ? " _(estimado)_" : ""}`),
      ...statements.map((s) => `• Fatura ${s.card} (${s.referenceMonth}) — ${s.remaining} (vence ${String(s.dueDate).split("-").reverse().join("/")})`),
    ];
    return {
      understood: true,
      toolCalls: calls,
      text: `${nextMonth ? `Para ${formatMonthBR(monthKey(addMonths(startOfMonth(today), 1)))}` : "Nos próximos 30 dias"} há *${total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}* a pagar:\n${lines.join("\n")}\n_Fonte: contas previstas e faturas registradas; valores variáveis são estimados._`,
    };
  }

  // 4. Faturas
  if (/\bfatura|cartao|cartoes|limite\b/.test(q)) {
    const r = await call("faturas_cartao", { card: null });
    const cards = r.cards as Any[];
    if (!cards.length) return { understood: true, toolCalls: calls, text: "Nenhum cartão cadastrado." };
    return {
      understood: true,
      toolCalls: calls,
      text: cards
        .map((c) => {
          const next = (c.statements as Any[]).find((s) => s.status !== "PAID") ?? c.statements[0];
          return `*${c.card}* — em aberto ${c.outstanding}${c.available ? ` · disponível ${c.available}` : ""}${next ? `\nFatura ${next.referenceMonth}: ${next.remaining} (vence ${String(next.dueDate).split("-").reverse().join("/")})` : ""}`;
        })
        .join("\n\n"),
    };
  }

  // 5. Metas
  if (/\bmetas?\b|\bobjetivo/.test(q)) {
    const r = await call("metas", {});
    const goals = r.goals as Any[];
    if (!goals.length) return { understood: true, toolCalls: calls, text: "Nenhuma meta cadastrada ainda." };
    return { understood: true, toolCalls: calls, text: goals.map((g) => `• ${g.name}: ${g.accumulated} de ${g.target} (${g.percent}%)${g.deadline ? ` · prazo ${String(g.deadline).split("-").reverse().join("/")}` : ""}`).join("\n") };
  }

  // 6. Assinaturas / recorrências
  if (/\bassinatura|recorrente|recorrencia|mensalidade/.test(q)) {
    const r = await call("recorrencias", { onlySubscriptions: /\bassinatura/.test(q) });
    const items = r.items as Any[];
    if (!items.length) return { understood: true, toolCalls: calls, text: /\bassinatura/.test(q) ? "Não há assinaturas ativas cadastradas (categoria Assinaturas)." : "Não há recorrências ativas cadastradas." };
    return { understood: true, toolCalls: calls, text: `Recorrências ativas:\n${items.map((i) => `• ${i.description} — ${i.amount}${i.variable ? " (estimado)" : ""}`).join("\n")}` };
  }

  // 7. Saldos
  if (/\bsaldo/.test(q) && !/\bfutur|projec|vai ficar/.test(q)) {
    const r = await call("saldos", {});
    return { understood: true, toolCalls: calls, text: `Saldo disponível: *${r.total}*\n${(r.accounts as Any[]).map((a) => `• ${a.name}: ${a.balance}`).join("\n")}` };
  }

  // 8. Projeção de fluxo de caixa
  if (/\bprojec|fluxo de caixa|saldo futuro|vai ficar|vamos ter\b/.test(q)) {
    const r = await call("projecao_fluxo_caixa", { days: 30 });
    return {
      understood: true,
      toolCalls: calls,
      text: `*Projeção* para ${String(r.end).split("-").reverse().join("/")}: saldo de ${r.endBalance} (hoje ${r.startBalance}). Ponto mais baixo: ${r.lowestPoint.balance} em ${String(r.lowestPoint.date).split("-").reverse().join("/")}.\nIncerteza: ${String(r.uncertainty).toLowerCase()}. Hipóteses: ${(r.assumptions as string[]).join(" ")}`,
    };
  }

  // 9. Média
  if (/\bmedia\b/.test(q)) {
    const monthsMatch = /\bultim[oa]s\s+(\d{1,2}|\p{L}+)\s+meses\b/u.exec(q);
    const months = monthsMatch ? (/^\d+$/.test(monthsMatch[1]!) ? Number(monthsMatch[1]) : spelledToNumber([monthsMatch[1]!]) ?? 3) : 3;
    const r = await call("media_gastos", { category: categoryName, months });
    if (r.error) return { understood: true, toolCalls: calls, text: r.error };
    return { understood: true, toolCalls: calls, text: `Média mensal de ${r.category === "todas" ? "despesas" : r.category} nos últimos ${r.months} meses completos: *${r.monthlyAverage}* (total ${r.total}, ${r.transactions} lançamentos).\n${FOOT_CONFIRMED}` };
  }

  // 10. Quanto ainda podemos gastar / ritmo
  if (/\b(ainda (podemos|posso|da pra|dá pra) gastar|quanto (sobra|resta|falta) (do|no) orcamento|ritmo|ate o (final|fim) do mes|podemos gastar)\b/.test(q) || /\borcamento\b/.test(q)) {
    const r = await call("ritmo_do_mes", { category: categoryName });
    if (r.budgetLimit === null) {
      return {
        understood: true,
        toolCalls: calls,
        text: `Não há orçamento definido${categoryName ? ` para ${r.category}` : ""} neste mês. Até agora foram gastos ${r.spentSoFar}; mantendo o ritmo, a *estimativa* para o mês é ${r.projectedMonthTotal}.`,
      };
    }
    return {
      understood: true,
      toolCalls: calls,
      text: `${categoryName ? `Em ${r.category}` : "No total dos orçamentos"}: gasto ${r.spentSoFar} de ${r.budgetLimit}. Restam *${r.remainingBudget}*${r.dailyAllowanceToStayInBudget ? ` (≈ ${r.dailyAllowanceToStayInBudget} por dia até o fim do mês)` : ""}.\n*Projeção* mantendo o ritmo atual: ${r.projectedMonthTotal} no mês (estimativa linear).`,
    };
  }

  // 11. Por pessoa
  if (/\bpor pessoa|quem gastou mais|cada um\b/.test(q)) {
    const r = await call("gastos_por_pessoa", { period: periodInput(period) });
    return { understood: true, toolCalls: calls, text: `Despesas ${ofPeriod(periodLabel)} por responsável:\n${(r.byResponsibility as Any[]).map((i) => `• ${i.name}: ${i.amount} (${i.percent}%)`).join("\n")}\n${FOOT_CONFIRMED}` };
  }

  // 12. Resumo
  if (/\bresumo|balanco|como estamos|como esta\b/.test(q)) {
    const r = await call("resumo_periodo", { period: periodInput(period), regime: null });
    const top = (r.topCategories as Any[]).slice(0, 5).map((c) => `• ${c.name}: ${c.amount} (${c.percent}%)`).join("\n");
    return {
      understood: true,
      toolCalls: calls,
      text: `Resumo de ${describePeriod(r.period)}:\nReceitas: *${r.income}*\nDespesas: *${r.expense}*\nResultado: *${r.result}*${r.expenseChangePct !== null ? `\nDespesas ${r.expenseChangePct >= 0 ? "+" : ""}${r.expenseChangePct}% vs. período anterior` : ""}${top ? `\nPrincipais categorias:\n${top}` : ""}\n${FOOT_CONFIRMED}`,
    };
  }

  // 13. Consultas de valor ("quanto gastamos...", "gastos acima de 200")
  const above = /\bacima de\b|\bmaior(es)? que\b|\bmais de\b/.test(q) ? extractAmounts(question)[0]?.cents ?? null : null;
  if (/\bquanto\b|\bgastos?\b|\bdespesas?\b|\breceitas?\b|\brecebemos\b/.test(q)) {
    const r = await call("buscar_transacoes", {
      period: periodInput(period),
      type: isIncome ? "INCOME" : "EXPENSE",
      category: categoryName,
      person: person?.name ?? null,
      minAmount: above ? above / 100 : null,
      maxAmount: null,
      text: null,
      paymentMethod: null,
      sort: above ? "amount_desc" : "date_desc",
      limit: above ? 15 : 5,
    });
    if (r.error) return { understood: true, toolCalls: calls, text: r.error };
    const total = isIncome ? r.totalIncome : r.totalExpense;
    const nature = await resolveScope(ctx);
    const natureLabel = nature === "BUSINESS" ? "(Empresa)" : nature === "ALL" ? "(pessoa física + empresa)" : null;
    const subject = [isIncome ? "Receitas" : "Despesas", natureLabel, categoryName ? `com ${r.filters.category ?? categoryName}` : null, person ? `de ${person.name}` : null].filter(Boolean).join(" ");
    if (above) {
      const items = r.items as Any[];
      return {
        understood: true,
        toolCalls: calls,
        text: items.length ? `${subject} acima de ${(above / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} ${inPeriod(periodLabel)} (${r.totalCount}):\n${items.map((i) => `• ${i.date.split("-").reverse().join("/")} ${i.description} — ${i.amount}`).join("\n")}` : `Nenhum lançamento acima desse valor ${inPeriod(periodLabel)}.`,
      };
    }
    return { understood: true, toolCalls: calls, text: `${subject} ${inPeriod(periodLabel)}: *${total}* (${r.totalCount} lançamento${r.totalCount === 1 ? "" : "s"} confirmado${r.totalCount === 1 ? "" : "s"}).\n${FOOT_CONFIRMED}` };
  }

  return {
    understood: false,
    toolCalls: calls,
    text: 'Ainda não sei responder essa pergunta. Exemplos: "Quanto gastamos este mês?", "Quanto gastamos com alimentação?", "Quais contas faltam pagar?", "Compara agosto e setembro", "Quais as cinco maiores despesas?".',
  };
}

export { endOfMonth };

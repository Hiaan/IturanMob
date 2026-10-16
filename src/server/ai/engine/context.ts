import type { FinancialRule, HouseholdSettings } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { todayISO } from "@/lib/dates";
import { getSettings } from "../../modules/households/service";
import { getVisibilityScope } from "../../modules/visibility/scope";
import { normalizeForNlu } from "../nlu/text";

/**
 * Contexto da família usado para interpretar mensagens: apenas nomes e identificadores
 * necessários (minimização de dados enviados a provedores externos).
 */
export interface HouseholdContext {
  householdId: string;
  timezone: string;
  today: string;
  sender: { memberId: string; displayName: string; relation: string | null } | null;
  members: Array<{ id: string; displayName: string; relation: string | null; hasLogin: boolean; aliases: string[] }>;
  accounts: Array<{ id: string; name: string; institution: string | null; type: string; currency?: string; aliases: string[] }>;
  cards: Array<{ id: string; name: string; issuer: string | null; last4: string | null; paymentAccountId: string | null; aliases: string[] }>;
  categories: Array<{
    id: string;
    name: string;
    kind: "EXPENSE" | "INCOME";
    normalized: string;
    subcategories: Array<{ id: string; name: string; normalized: string; keywords: string[] }>;
  }>;
  goals: Array<{ id: string; name: string; accountId: string | null; aliases: string[] }>;
  rules: FinancialRule[];
  settings: HouseholdSettings;
}

const GENERIC_WORDS = new Set(["conta", "cartao", "credito", "debito", "corrente", "de", "da", "do", "banco", "poupanca", "digital", "meu", "minha", "o", "a"]);

function aliasesFor(...names: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const norm = normalizeForNlu(n);
    if (!norm) continue;
    set.add(norm);
    const meaningful = norm.split(" ").filter((w) => !GENERIC_WORDS.has(w) && w.length > 1);
    if (meaningful.length) set.add(meaningful.join(" "));
    for (const w of meaningful) if (w.length >= 3) set.add(w);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

const RELATION_ALIASES: Record<string, string[]> = {
  esposa: ["esposa", "mulher", "minha esposa", "minha mulher", "patroa"],
  marido: ["marido", "meu marido", "esposo", "meu esposo"],
  filho: ["filho", "meu filho", "nosso filho", "filhote"],
  filha: ["filha", "minha filha", "nossa filha"],
  mae: ["mae", "minha mae", "sogra"],
  pai: ["pai", "meu pai", "sogro"],
};

function memberAliases(displayName: string, relation: string | null): string[] {
  const set = new Set<string>(aliasesFor(displayName));
  const firstName = normalizeForNlu(displayName).split(" ")[0];
  if (firstName && firstName.length > 2) set.add(firstName);
  if (relation) {
    const rel = normalizeForNlu(relation);
    set.add(rel);
    for (const [key, list] of Object.entries(RELATION_ALIASES)) {
      if (rel.includes(key)) list.forEach((a) => set.add(a));
    }
  }
  return [...set];
}

export async function loadHouseholdContext(ctx: ServiceContext, senderMemberId?: string | null): Promise<HouseholdContext> {
  const scope = await getVisibilityScope(ctx);
  const [members, accounts, cards, categories, goals, rules, settings] = await Promise.all([
    prisma.householdMember.findMany({ where: { householdId: ctx.householdId, isActive: true }, orderBy: { createdAt: "asc" } }),
    prisma.account.findMany({ where: { householdId: ctx.householdId, archivedAt: null, id: { notIn: scope.hiddenAccountIds } } }),
    prisma.creditCard.findMany({ where: { householdId: ctx.householdId, archivedAt: null, id: { notIn: scope.hiddenCardIds } } }),
    prisma.category.findMany({
      where: { householdId: ctx.householdId, archivedAt: null },
      include: { subcategories: { where: { archivedAt: null }, orderBy: { sortOrder: "asc" } } },
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
    }),
    prisma.financialGoal.findMany({ where: { householdId: ctx.householdId, status: "ACTIVE" } }),
    prisma.financialRule.findMany({ where: { householdId: ctx.householdId, active: true } }),
    getSettings(ctx.householdId),
  ]);
  const senderId = senderMemberId ?? ctx.memberId;
  const sender = members.find((m) => m.id === senderId) ?? null;
  return {
    householdId: ctx.householdId,
    timezone: ctx.timezone,
    today: todayISO(ctx.timezone),
    sender: sender ? { memberId: sender.id, displayName: sender.displayName, relation: sender.relation } : null,
    members: members.map((m) => ({ id: m.id, displayName: m.displayName, relation: m.relation, hasLogin: Boolean(m.userId), aliases: memberAliases(m.displayName, m.relation) })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, currency: a.currency, aliases: aliasesFor(a.name, a.institution) })),
    cards: cards.map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, last4: c.last4, paymentAccountId: c.paymentAccountId, aliases: aliasesFor(c.name, c.issuer) })),
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      normalized: normalizeForNlu(c.name),
      subcategories: c.subcategories.map((s) => ({ id: s.id, name: s.name, normalized: normalizeForNlu(s.name), keywords: s.keywords })),
    })),
    goals: goals.map((g) => ({ id: g.id, name: g.name, accountId: g.accountId, aliases: aliasesFor(g.name) })),
    rules,
    settings,
  };
}

/** Lista de categorias no formato usado nos prompts ("Categoria > Subcategoria"). */
export function categoryCatalog(hc: HouseholdContext, kind?: "EXPENSE" | "INCOME"): string[] {
  const out: string[] = [];
  for (const c of hc.categories) {
    if (kind && c.kind !== kind) continue;
    if (!c.subcategories.length) out.push(`${c.name}`);
    for (const s of c.subcategories) out.push(`${c.name} > ${s.name}`);
  }
  return out;
}

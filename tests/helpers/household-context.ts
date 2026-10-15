import type { HouseholdContext } from "@/server/ai/engine/context";
import { DEFAULT_CATEGORIES } from "@/server/modules/categories/defaults";
import { normalizeForNlu } from "@/server/ai/nlu/text";

/** Contexto sintético de família para testes do motor (sem banco de dados). */
export function makeHouseholdContext(overrides: Partial<HouseholdContext> = {}): HouseholdContext {
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  const categories = DEFAULT_CATEGORIES.map((c) => ({
    id: id("cat"),
    name: c.name,
    kind: c.kind,
    normalized: normalizeForNlu(c.name),
    subcategories: c.subcategories.map((s) => ({ id: id("sub"), name: s.name, normalized: normalizeForNlu(s.name), keywords: s.keywords })),
  }));
  return {
    householdId: "hh_1",
    timezone: "America/Recife",
    today: "2026-10-15",
    sender: { memberId: "m_joao", displayName: "João", relation: "Marido" },
    members: [
      { id: "m_joao", displayName: "João", relation: "Marido", hasLogin: true, aliases: ["joao", "marido", "meu marido", "esposo", "meu esposo"] },
      { id: "m_maria", displayName: "Maria", relation: "Esposa", hasLogin: true, aliases: ["maria", "esposa", "mulher", "minha esposa", "minha mulher", "patroa"] },
      { id: "m_pedro", displayName: "Pedro", relation: "Filho", hasLogin: false, aliases: ["pedro", "filho", "meu filho", "nosso filho", "filhote"] },
    ],
    accounts: [
      { id: "acc_nubank", name: "Nubank", institution: "Nubank", type: "DIGITAL", aliases: ["nubank"] },
      { id: "acc_itau", name: "Itaú", institution: "Itaú", type: "CHECKING", aliases: ["itau"] },
      { id: "acc_carteira", name: "Carteira", institution: null, type: "WALLET", aliases: ["carteira"] },
    ],
    cards: [
      { id: "card_nubank", name: "Nubank Crédito", issuer: "Nubank", last4: null, paymentAccountId: "acc_nubank", aliases: ["nubank credito", "nubank"] },
      { id: "card_itau", name: "Itaú Visa", issuer: "Itaú", last4: null, paymentAccountId: "acc_itau", aliases: ["itau visa", "visa", "itau"] },
    ],
    categories,
    goals: [{ id: "goal_viagem", name: "Viagem", accountId: null, aliases: ["viagem"] }],
    rules: [],
    settings: {
      householdId: "hh_1",
      defaultRegime: "ACCRUAL",
      confidenceHigh: 0.85,
      confidenceMedium: 0.6,
      budgetAlertThresholds: [50, 75, 90, 100],
      mediaRetentionDays: 90,
      transcriptRetentionDays: 365,
      aiExternalAllowed: false,
      aiAudioAllowed: false,
      aiImageAllowed: false,
      duplicateWindowHours: 48,
      whatsappReplies: true,
      whatsappAnswerQueries: true,
      updatedAt: new Date(),
    },
    ...overrides,
  };
}

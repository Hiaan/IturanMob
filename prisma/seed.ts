/**
 * Seed de DEMONSTRAÇÃO — opcional e explícito.
 *
 * O sistema não precisa de seed: o primeiro cadastro em /cadastro cria a família com as categorias padrão.
 * Este script existe só para avaliar a interface com dados de exemplo. Tudo o que ele cria é FICTÍCIO e
 * fica identificado como tal (nome da família, descrições e e-mails @demo.invalid).
 *
 *   SEED_DEMO=true pnpm db:seed
 *
 * Recusa-se a rodar em produção e não toca em famílias existentes.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

if (process.env.SEED_DEMO !== "true") {
  console.log("[seed] Nada a fazer. O sistema não precisa de dados iniciais: o primeiro cadastro em /cadastro cria a família.");
  console.log("[seed] Para criar uma família de DEMONSTRAÇÃO com dados fictícios: SEED_DEMO=true pnpm db:seed");
  process.exit(0);
}
if (process.env.NODE_ENV === "production") {
  console.error("[seed] Recusado: dados de demonstração não podem ser criados em produção.");
  process.exit(1);
}

// A família de demonstração é criada mesmo com o cadastro público desativado (só neste processo).
process.env.ALLOW_REGISTRATION = "true";

const { prisma } = await import("../src/server/db");
const { registerHousehold } = await import("../src/server/modules/households/service");
const { createAccount } = await import("../src/server/modules/accounts/service");
const { createCard } = await import("../src/server/modules/cards/service");
const { createTransaction } = await import("../src/server/modules/transactions/service");
const { upsertBudget } = await import("../src/server/modules/budgets/service");
const { createGoal, contributeToGoal } = await import("../src/server/modules/goals/service");
const { createRecurring } = await import("../src/server/modules/recurring/service");
const { hashPassword } = await import("../src/server/crypto");
const { todayISO, addDays } = await import("../src/lib/dates");
type ServiceContext = import("../src/server/auth/context").ServiceContext;

const OWNER_EMAIL = "demo@demo.invalid";
const PARTNER_EMAIL = "demo.parceira@demo.invalid";
const PASSWORD = "Demonstracao#2026";
const TZ = "America/Recife";

if (await prisma.user.findUnique({ where: { email: OWNER_EMAIL } })) {
  console.log(`[seed] A família de demonstração já existe (login: ${OWNER_EMAIL}). Nada foi alterado.`);
  process.exit(0);
}

const { household, member } = await registerHousehold({
  householdName: "Demonstração (dados fictícios)",
  name: "Pessoa Demo 1",
  email: OWNER_EMAIL,
  password: PASSWORD,
  relation: "Titular",
  timezone: TZ,
});
const partnerUser = await prisma.user.create({ data: { email: PARTNER_EMAIL, name: "Pessoa Demo 2", passwordHash: await hashPassword(PASSWORD) } });
const partner = await prisma.householdMember.create({
  data: { householdId: household.id, userId: partnerUser.id, displayName: "Pessoa Demo 2", relation: "Cônjuge", role: "ADMIN", color: "#be185d" },
});

const ctx: ServiceContext = {
  householdId: household.id,
  memberId: member.id,
  userId: member.userId,
  role: "OWNER",
  actorType: "SYSTEM",
  timezone: TZ,
  canViewOthersPrivate: false,
};

const categories = await prisma.category.findMany({ where: { householdId: household.id }, include: { subcategories: true } });
const cat = (name: string, kind: "EXPENSE" | "INCOME" = "EXPENSE") => {
  const c = categories.find((x) => x.name === name && x.kind === kind);
  if (!c) throw new Error(`Categoria padrão ausente: ${name}`);
  return c.id;
};
/** Categoria + subcategoria padrão. */
const sub = (catName: string, subName: string, kind: "EXPENSE" | "INCOME" = "EXPENSE") => {
  const c = categories.find((x) => x.name === catName && x.kind === kind);
  const s = c?.subcategories.find((x) => x.name === subName);
  if (!c || !s) throw new Error(`Subcategoria padrão ausente: ${catName} › ${subName}`);
  return { categoryId: c.id, subcategoryId: s.id };
};

const today = todayISO(TZ);
const monthStart = (offset: number) => {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 10);
};
const day = (offsetMonths: number, d: number) => {
  const start = monthStart(offsetMonths);
  const candidate = `${start.slice(0, 8)}${String(d).padStart(2, "0")}`;
  return candidate > today ? addDays(today, -1) : candidate;
};

const conta = await createAccount(ctx, { name: "Conta corrente (demo)", institution: "Banco Demo", type: "CHECKING", initialBalanceCents: 420_000, initialBalanceDate: monthStart(-3) });
const digital = await createAccount(ctx, { name: "Conta digital (demo)", institution: "Banco Digital Demo", type: "DIGITAL", initialBalanceCents: 85_000, initialBalanceDate: monthStart(-3), ownerMemberId: partner.id });
const cartao = await createCard(ctx, { name: "Cartão (demo)", issuer: "Banco Demo", closingDay: 3, dueDay: 10, limitCents: 800_000, paymentAccountId: conta.id });

type Tx = Parameters<typeof createTransaction>[1];
const txs: Tx[] = [];
for (const m of [-2, -1, 0]) {
  txs.push(
    { type: "INCOME", amountCents: 650_000, description: "Salário (demo)", date: day(m, 5), ...sub("Trabalho", "Salário", "INCOME"), accountId: conta.id, paymentMethod: "BANK_TRANSFER", payerMemberId: member.id },
    { type: "INCOME", amountCents: 380_000, description: "Salário (demo)", date: day(m, 6), ...sub("Trabalho", "Salário", "INCOME"), accountId: digital.id, paymentMethod: "BANK_TRANSFER", payerMemberId: partner.id },
    { type: "EXPENSE", amountCents: 180_000, description: "Aluguel (demo)", date: day(m, 8), ...sub("Moradia", "Aluguel"), accountId: conta.id, paymentMethod: "PIX", payerMemberId: member.id },
    { type: "EXPENSE", amountCents: 61_250 + m * 3_100, description: "Supermercado (demo)", date: day(m, 9), ...sub("Alimentação", "Supermercado"), creditCardId: cartao.id, paymentMethod: "CREDIT_CARD", payerMemberId: partner.id },
    { type: "EXPENSE", amountCents: 23_480, description: "Energia (demo)", date: day(m, 12), ...sub("Moradia", "Energia"), accountId: conta.id, paymentMethod: "BANK_SLIP", payerMemberId: member.id },
    { type: "EXPENSE", amountCents: 8_990 + m * 450, description: "Farmácia (demo)", date: day(m, 14), ...sub("Saúde", "Medicamentos"), accountId: digital.id, paymentMethod: "DEBIT_CARD", payerMemberId: partner.id },
    { type: "EXPENSE", amountCents: 4_270, description: "Transporte por aplicativo (demo)", date: day(m, 16), ...sub("Transporte", "Aplicativos de transporte"), creditCardId: cartao.id, paymentMethod: "CREDIT_CARD", payerMemberId: member.id },
    { type: "EXPENSE", amountCents: 12_800, description: "Restaurante (demo)", date: day(m, 18), ...sub("Alimentação", "Restaurantes"), accountId: conta.id, paymentMethod: "PIX", payerMemberId: member.id },
  );
}
txs.push({ type: "EXPENSE", amountCents: 239_880, description: "Geladeira parcelada (demo)", date: day(-1, 20), categoryId: cat("Moradia"), creditCardId: cartao.id, paymentMethod: "CREDIT_CARD", installmentCount: 10, payerMemberId: member.id });
txs.push({ type: "TRANSFER", amountCents: 50_000, description: "Transferência entre contas (demo)", date: day(0, 2), accountId: conta.id, destinationAccountId: digital.id, paymentMethod: "PIX", payerMemberId: member.id });

for (const tx of txs) await createTransaction(ctx, tx, { source: "SYSTEM", checkDuplicates: false });

const month = today.slice(0, 7);
for (const [name, limit] of [["Alimentação", 90_000], ["Transporte", 20_000], ["Saúde", 15_000]] as const) {
  await upsertBudget(ctx, { categoryId: cat(name), month, limitCents: limit });
}
const goal = await createGoal(ctx, { name: "Reserva de emergência (demo)", targetCents: 2_000_000, accountId: digital.id });
await contributeToGoal(ctx, goal.id, { amountCents: 150_000, date: day(0, 6), note: "Aporte de demonstração" });
await createRecurring(ctx, { type: "EXPENSE", description: "Internet (demo)", amountCents: 11_990, ...sub("Moradia", "Internet"), accountId: conta.id, paymentMethod: "AUTO_DEBIT", dayOfMonth: 15, startDate: monthStart(0) });

console.log(`[seed] Família de DEMONSTRAÇÃO criada com dados fictícios.
  Login: ${OWNER_EMAIL}  (ou ${PARTNER_EMAIL})
  Senha: ${PASSWORD}
  Para removê-la, exclua a família em Configurações → Dados e LGPD.`);
await prisma.$disconnect();
// Conexões auxiliares (Redis de eventos) mantêm o processo vivo; o seed termina aqui.
process.exit(0);

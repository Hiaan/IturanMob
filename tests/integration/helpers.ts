import { prisma } from "@/server/db";
import { registerHousehold } from "@/server/modules/households/service";
import type { ServiceContext } from "@/server/auth/context";
import { createAccount } from "@/server/modules/accounts/service";
import { createCard } from "@/server/modules/cards/service";
import { randomBytes } from "node:crypto";

/** Limpa todas as tabelas do banco de testes. */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (!tables.length) return;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export interface TestFamily {
  ctx: ServiceContext;
  householdId: string;
  husbandId: string;
  wifeId: string;
  wifeCtx: ServiceContext;
}

let counter = 0;

/** Cria uma família de teste com marido (proprietário) e esposa (membro). */
export async function createFamily(name = "Família Teste"): Promise<TestFamily> {
  counter++;
  const suffix = `${Date.now()}-${counter}-${randomBytes(3).toString("hex")}`;
  const { household, member } = await registerHousehold({
    householdName: name,
    name: "João",
    email: `joao-${suffix}@example.com`,
    password: "SenhaForte#2026",
    relation: "Marido",
  });
  const wifeUser = await prisma.user.create({ data: { email: `maria-${suffix}@example.com`, name: "Maria", passwordHash: "x" } });
  const wife = await prisma.householdMember.create({
    data: { householdId: household.id, userId: wifeUser.id, displayName: "Maria", relation: "Esposa", role: "MEMBER", color: "#be185d" },
  });
  const ctx: ServiceContext = {
    householdId: household.id,
    memberId: member.id,
    userId: member.userId,
    role: "OWNER",
    actorType: "USER",
    timezone: "America/Recife",
    canViewOthersPrivate: false,
  };
  const wifeCtx: ServiceContext = { ...ctx, memberId: wife.id, userId: wifeUser.id, role: "MEMBER" };
  return { ctx, householdId: household.id, husbandId: member.id, wifeId: wife.id, wifeCtx };
}

export async function createBasicAccounts(ctx: ServiceContext) {
  const nubank = await createAccount(ctx, { name: "Nubank", institution: "Nubank", type: "DIGITAL", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
  const itau = await createAccount(ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 500_000, initialBalanceDate: "2026-01-01" });
  const card = await createCard(ctx, { name: "Nubank Crédito", issuer: "Nubank", closingDay: 3, dueDay: 10, limitCents: 1_000_000, paymentAccountId: nubank.id });
  return { nubank, itau, card };
}

export async function categoryId(householdId: string, name: string, kind: "EXPENSE" | "INCOME" = "EXPENSE") {
  const c = await prisma.category.findFirstOrThrow({ where: { householdId, name, kind } });
  return c.id;
}

export async function subcategory(householdId: string, name: string) {
  return prisma.subcategory.findFirstOrThrow({ where: { householdId, name } });
}

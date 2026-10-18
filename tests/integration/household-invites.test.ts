import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { registerHousehold } from "@/server/modules/households/service";
import { createHouseholdInvite, householdInviteStatus, isInstanceAdmin, listHouseholdInvites, revokeHouseholdInvite } from "@/server/modules/instance/invites";
import { createTransaction } from "@/server/modules/transactions/service";
import { listTransactions } from "@/server/modules/transactions/service";
import { createAccount } from "@/server/modules/accounts/service";
import type { ServiceContext } from "@/server/auth/context";
import { createFamily, resetDatabase } from "./helpers";

/**
 * Convite para criar UMA nova família (link de uso único, 7 dias) com o cadastro público fechado.
 * Só o administrador da instância gera; a família criada é separada (nenhum dado compartilhado).
 */

const saved = { reg: process.env.ALLOW_REGISTRATION, admins: process.env.INSTANCE_ADMIN_EMAILS };
const tokenOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get("convite")!);
const signup = (n: number, inviteToken?: string) =>
  registerHousehold({ householdName: `Família Nova ${n}`, name: "Ana", email: `ana-${n}-${Date.now()}@example.com`, password: "SenhaForte#2026", ...(inviteToken ? { inviteToken } : {}) });

function closeRegistration() {
  process.env.ALLOW_REGISTRATION = "false";
  resetEnvCache();
}

describe("Convite para nova família", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    for (const [k, v] of [["ALLOW_REGISTRATION", saved.reg], ["INSTANCE_ADMIN_EMAILS", saved.admins]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  });

  it("administrador da instância = proprietário da primeira família (ou INSTANCE_ADMIN_EMAILS); os demais não geram convites", async () => {
    const first = await createFamily("Primeira");
    const second = await createFamily("Segunda");
    expect(await isInstanceAdmin(first.ctx.userId)).toBe(true);
    expect(await isInstanceAdmin(first.wifeCtx.userId)).toBe(false);
    expect(await isInstanceAdmin(second.ctx.userId)).toBe(false);
    await expect(createHouseholdInvite(second.ctx)).rejects.toThrow(/administrador desta instalação/);
    await expect(createHouseholdInvite(first.wifeCtx)).rejects.toThrow(/administrador desta instalação/);
    expect(await listHouseholdInvites(second.ctx)).toEqual({ canInvite: false, ttlDays: 7, items: [] });

    // Com a variável, vale só a lista de e-mails.
    const secondUser = await prisma.user.findUniqueOrThrow({ where: { id: second.ctx.userId! } });
    process.env.INSTANCE_ADMIN_EMAILS = ` ${secondUser.email.toUpperCase()} , outro@example.com`;
    resetEnvCache();
    expect(await isInstanceAdmin(second.ctx.userId)).toBe(true);
    expect(await isInstanceAdmin(first.ctx.userId)).toBe(false);
  });

  it("link de uso único: cria UMA família separada com o cadastro fechado; não reaproveita; dados não se misturam", async () => {
    const admin = await createFamily("Família Admin");
    const itau = await createAccount(admin.ctx, { name: "Itaú", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
    await createTransaction(admin.ctx, { type: "EXPENSE", amountCents: 5_000, description: "Mercado", date: "2026-10-10", accountId: itau.id });
    closeRegistration();

    // Sem convite, o cadastro continua fechado.
    await expect(signup(1)).rejects.toThrow(/cadastro público está desativado/);

    const invite = await createHouseholdInvite(admin.ctx, { label: "Família do Ícaro" });
    expect(invite).toMatchObject({ status: "ACTIVE", label: "Família do Ícaro" });
    expect(invite.url).toMatch(/\/cadastro\?convite=/);
    const token = tokenOf(invite.url);
    expect(invite.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(invite.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    // O token não fica no banco (só o hash).
    const row = await prisma.householdInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.tokenHash).not.toContain(token);
    expect(await householdInviteStatus(token)).toMatchObject({ valid: true, reason: null });

    const created = await signup(2, token);
    expect(created.member.role).toBe("OWNER");
    expect(created.household.id).not.toBe(admin.householdId);
    // Família nova: só a pessoa convidada, categorias próprias, nenhum lançamento da outra.
    expect(await prisma.householdMember.count({ where: { householdId: created.household.id } })).toBe(1);
    expect(await prisma.category.count({ where: { householdId: created.household.id } })).toBeGreaterThan(0);
    const newCtx: ServiceContext = { householdId: created.household.id, memberId: created.member.id, userId: created.user.id, role: "OWNER", actorType: "USER", timezone: "America/Recife", canViewOthersPrivate: false };
    expect((await listTransactions(newCtx, {})).total).toBe(0);
    expect((await listTransactions(admin.ctx, {})).total).toBe(1);
    // A pessoa convidada não vira administradora da instância.
    expect(await isInstanceAdmin(created.user.id)).toBe(false);

    // Uso único.
    expect(await householdInviteStatus(token)).toMatchObject({ valid: false, reason: "USED" });
    await expect(signup(3, token)).rejects.toThrow(/Convite inválido, expirado ou já usado/);
    const list = await listHouseholdInvites(admin.ctx);
    expect(list.items[0]).toMatchObject({ id: invite.id, status: "USED", createdHouseholdName: "Família Nova 2" });
    await expect(revokeHouseholdInvite(admin.ctx, invite.id)).rejects.toThrow(/já foi usado/);
    expect(await prisma.auditLog.count({ where: { householdId: admin.householdId, entityType: "HouseholdInvite", action: "CREATE" } })).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { householdId: created.household.id, entityType: "Household", action: "CREATE" } })).toMatchObject({ metadata: { via: "HouseholdInvite", inviteId: invite.id } });
  });

  it("dois cadastros ao mesmo tempo com o mesmo link: só um cria a família", async () => {
    const admin = await createFamily("Família Admin");
    closeRegistration();
    const token = tokenOf((await createHouseholdInvite(admin.ctx)).url);
    const results = await Promise.allSettled([signup(10, token), signup(11, token), signup(12, token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.household.count({ where: { name: { startsWith: "Família Nova 1" } } })).toBe(1);
    // As tentativas que falharam não deixam usuário nem família pela metade.
    expect(await prisma.user.count({ where: { name: "Ana" } })).toBe(1);
  });

  it("expirado, revogado ou inválido não cria família; e-mail já usado não consome o convite", async () => {
    const admin = await createFamily("Família Admin");
    closeRegistration();
    const a = await createHouseholdInvite(admin.ctx);
    await prisma.householdInvite.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await householdInviteStatus(tokenOf(a.url))).toMatchObject({ valid: false, reason: "EXPIRED" });
    await expect(signup(20, tokenOf(a.url))).rejects.toThrow(/Convite inválido/);

    const b = await createHouseholdInvite(admin.ctx);
    expect(await revokeHouseholdInvite(admin.ctx, b.id)).toMatchObject({ status: "REVOKED" });
    await expect(signup(21, tokenOf(b.url))).rejects.toThrow(/Convite inválido/);
    expect(await householdInviteStatus("x".repeat(43))).toMatchObject({ valid: false, reason: "INVALID" });

    const c = await createHouseholdInvite(admin.ctx);
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { id: admin.ctx.userId! } });
    await expect(registerHousehold({ householdName: "Repetida", name: "João", email: adminUser.email, password: "SenhaForte#2026", inviteToken: tokenOf(c.url) })).rejects.toThrow(/Já existe uma conta/);
    expect(await householdInviteStatus(tokenOf(c.url))).toMatchObject({ valid: true });
    expect((await listHouseholdInvites(admin.ctx)).items.map((i) => i.status).sort()).toEqual(["ACTIVE", "EXPIRED", "REVOKED"]);
  });
});

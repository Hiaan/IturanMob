import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { encryptString } from "@/server/crypto";
import { createSession } from "@/server/auth/session";
import { storedFileExists } from "@/server/storage";
import { createInvitation } from "@/server/modules/households/service";
import { categoryId, createBasicAccounts, createFamily, resetDatabase } from "./helpers";
import { createTransaction, deleteTransaction } from "@/server/modules/transactions/service";
import { createAccount } from "@/server/modules/accounts/service";
import { exportFullHouseholdData, exportFullHouseholdFile, exportTransactions } from "@/server/modules/exports/service";
import { deleteHousehold, deleteMemberAccount } from "@/server/modules/privacy/service";
import { createImportPreview } from "@/server/modules/imports/service";

describe("exportações", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("exporta transações em CSV (pt-BR) e XLSX com os filtros da listagem", async () => {
    const fam = await createFamily();
    const { nubank, itau, card } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "INCOME", amountCents: 350_000, description: "Salário", date: "2026-10-05", accountId: itau.id, categoryId: await categoryId(fam.householdId, "Trabalho", "INCOME") });
    await createTransaction(fam.ctx, {
      type: "EXPENSE",
      amountCents: 123_456,
      description: "=HYPERLINK(\"x\")",
      date: "2026-10-06",
      accountId: nubank.id,
      allocations: [
        { memberId: fam.husbandId, amountCents: 100_000 },
        { memberId: fam.wifeId, amountCents: 23_456 },
      ],
    });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 9_000, description: "Cinema", date: "2026-10-07", creditCardId: card.id, ownership: "INDIVIDUAL", responsibleMemberId: fam.wifeId });
    await createTransaction(fam.ctx, { type: "TRANSFER", amountCents: 10_000, description: "Reserva", date: "2026-10-08", accountId: itau.id, destinationAccountId: nubank.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 500, description: "Fora do período", date: "2026-09-30", accountId: nubank.id });

    const csv = await exportTransactions(fam.ctx, { start: "2026-10-01", end: "2026-10-31", sort: "date_asc" }, "csv");
    expect(csv.rowCount).toBe(4);
    expect(csv.contentType).toBe("text/csv; charset=utf-8");
    expect(csv.fileName).toMatch(/^transacoes-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = csv.content.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("Data;Descrição;Categoria;Subcategoria;Tipo;Valor;Forma de pagamento;Conta/Cartão;Responsável;Situação");
    expect(lines[1]).toBe("05/10/2026;Salário;Trabalho;;Receita;3500,00;;Itaú;Família;Confirmada");
    // Texto com fórmula é neutralizado; aspas escapadas; rateio descrito.
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[2]).toContain(";-1234,56;");
    expect(lines[2]).toContain("João (R$ 1.000,00); Maria (R$ 234,56)");
    expect(lines[3]).toBe("07/10/2026;Cinema;Sem categoria;;Despesa;-90,00;Cartão de crédito;Nubank Crédito;Maria;Confirmada");
    expect(lines[4]).toContain(";Transferência;100,00;Transferência bancária;Itaú → Nubank;;Confirmada");

    const xlsx = await exportTransactions(fam.ctx, { types: ["EXPENSE"], start: "2026-10-01" }, "xlsx");
    expect(xlsx.content.subarray(0, 2).toString("latin1")).toBe("PK");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.content as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0]!;
    expect(ws.actualRowCount).toBe(3);
    expect(ws.getRow(1).font?.bold).toBe(true);
    const amounts = [ws.getRow(2).getCell(6).value, ws.getRow(3).getCell(6).value].sort();
    expect(amounts).toEqual([-1234.56, -90]);
    expect(ws.getRow(2).getCell(6).numFmt).toContain("R$");

    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "EXPORT", entityType: "Transaction" } })).toBe(2);
    await expect(exportTransactions({ ...fam.ctx, role: "VIEWER" }, {}, "csv")).rejects.toThrow(/permissão/);
  });

  it("exportação completa (LGPD) inclui os dados da família e nunca senhas, tokens ou chaves", async () => {
    const fam = await createFamily("Família Portabilidade");
    const { nubank } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 4_500, description: "Farmácia", date: "2026-10-10", accountId: nubank.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1_000, description: "Café", date: "2026-10-11", accountId: nubank.id });
    await deleteTransaction(fam.ctx, transaction.id);
    const session = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const invite = await createInvitation(fam.ctx, { email: "convidado@example.com", role: "MEMBER" });
    const inviteToken = invite.url.split("/").pop()!;
    const apiKey = "sk-ant-segredo-que-nao-pode-vazar-123";
    await prisma.aIProviderCredential.create({ data: { householdId: fam.householdId, provider: "ANTHROPIC", encryptedApiKey: encryptString(apiKey) } });
    const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId } });
    await prisma.whatsAppAuthState.create({ data: { connectionId: conn.id, key: "creds", value: encryptString('{"noiseKey":"segredo-whatsapp"}') } });
    const priv = await createAccount(fam.wifeCtx, { name: "Conta privada da Maria", visibility: "PRIVATE" });

    const data = await exportFullHouseholdData(fam.ctx);
    const json = JSON.stringify(data);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: fam.ctx.userId! } });
    const sessionRow = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    const inviteRow = await prisma.invitation.findFirstOrThrow({ where: { householdId: fam.householdId } });
    const cred = await prisma.aIProviderCredential.findFirstOrThrow({ where: { householdId: fam.householdId } });

    for (const forbidden of ["passwordHash", "tokenHash", "encryptedApiKey", user.passwordHash, sessionRow.tokenHash, inviteRow.tokenHash, cred.encryptedApiKey, session.token, inviteToken, apiKey, "segredo-whatsapp"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(data.format).toBe("finance-ai-household-export");
    expect((data.household as { name: string }).name).toBe("Família Portabilidade");
    const members = data.members as Array<{ displayName: string; user: { email: string } | null }>;
    expect(members.map((m) => m.displayName).sort()).toEqual(["João", "Maria"]);
    expect(members.every((m) => m.user?.email.endsWith("@example.com"))).toBe(true);
    const txs = data.transactions as Array<{ description: string; deleted: boolean; date: string }>;
    expect(txs).toHaveLength(2);
    expect(txs.find((t) => t.description === "Farmácia")).toMatchObject({ deleted: true, date: "2026-10-10" });
    expect((data.categories as unknown[]).length).toBeGreaterThan(5);
    // Conta privada de outro membro não sai na exportação do marido.
    expect(json).not.toContain(priv.id);
    expect(data.counts).toMatchObject({ transactions: 2, members: 2 });
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "EXPORT", entityType: "Household" } })).toBe(1);

    const file = await exportFullHouseholdFile(fam.wifeCtx);
    expect(file.contentType).toContain("application/json");
    expect(JSON.parse(file.content.toString("utf8")).accounts.map((a: { id: string }) => a.id)).toContain(priv.id);
    await expect(exportFullHouseholdData({ ...fam.ctx, role: "VIEWER" })).rejects.toThrow(/permissão/);
  });
});

describe("privacidade (LGPD)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("exclusão da própria conta anonimiza o membro e preserva o histórico", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.wifeCtx, { type: "EXPENSE", amountCents: 3_000, description: "Lanche", date: "2026-10-10", accountId: nubank.id });
    await createSession({ userId: fam.wifeCtx.userId!, householdId: fam.householdId });

    await expect(deleteMemberAccount(fam.ctx, { confirmation: "EXCLUIR" })).rejects.toThrow(/proprietário/);
    await expect(deleteMemberAccount(fam.wifeCtx, { confirmation: "sim" })).rejects.toThrow(/EXCLUIR/);
    const result = await deleteMemberAccount(fam.wifeCtx, { confirmation: "EXCLUIR" });
    expect(result).toMatchObject({ deleted: true, userDeleted: true });

    const member = await prisma.householdMember.findUniqueOrThrow({ where: { id: fam.wifeId } });
    expect(member).toMatchObject({ displayName: "Ex-membro", userId: null, isActive: false, whatsappPhone: null });
    expect(await prisma.user.findUnique({ where: { id: fam.wifeCtx.userId! } })).toBeNull();
    expect(await prisma.session.count({ where: { userId: fam.wifeCtx.userId! } })).toBe(0);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(tx.payerMemberId).toBe(fam.wifeId);
    expect(tx.deletedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "DELETE", entityType: "HouseholdMember", entityId: fam.wifeId } })).toBe(1);
  });

  it("exclusão da família exige o nome exato, remove arquivos e dados, e preserva outras famílias", async () => {
    const fam = await createFamily("Família Souza");
    const other = await createFamily("Família Vizinha");
    const { nubank } = await createBasicAccounts(fam.ctx);
    const otherAccounts = await createBasicAccounts(other.ctx);
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1_000, description: "Café", date: "2026-10-10", accountId: nubank.id });
    await createTransaction(other.ctx, { type: "EXPENSE", amountCents: 2_000, description: "Pão", date: "2026-10-10", accountId: otherAccounts.nubank.id });
    await createImportPreview(fam.ctx, { fileName: "x.csv", contentBase64: Buffer.from("Data;Descrição;Valor\n01/10/2026;Café;-5,00").toString("base64"), accountId: nubank.id });
    const attachment = await prisma.attachment.findFirstOrThrow({ where: { householdId: fam.householdId } });
    expect(await storedFileExists(attachment.storageKey!)).toBe(true);

    await expect(deleteHousehold(fam.wifeCtx, { confirmation: "Família Souza" })).rejects.toThrow(/permissão/);
    await expect(deleteHousehold(fam.ctx, { confirmation: "familia souza" })).rejects.toThrow(/nome da família/);

    const result = await deleteHousehold(fam.ctx, { confirmation: "Família Souza" });
    expect(result).toMatchObject({ deleted: true, filesRemoved: 1, usersRemoved: 2 });
    expect(await prisma.household.findUnique({ where: { id: fam.householdId } })).toBeNull();
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    expect(await prisma.user.count({ where: { id: { in: [fam.ctx.userId!, fam.wifeCtx.userId!] } } })).toBe(0);
    expect(await storedFileExists(attachment.storageKey!)).toBe(false);
    expect(await prisma.auditLog.count({ where: { householdId: null, action: "DELETE", entityType: "Household", entityId: fam.householdId } })).toBe(1);

    // A outra família não é afetada.
    expect(await prisma.transaction.count({ where: { householdId: other.householdId } })).toBe(1);
    expect(await prisma.user.count({ where: { id: other.ctx.userId! } })).toBe(1);
  });
  it("rotas da API: exportações para download e exclusão da própria conta encerra a sessão", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1_000, description: "Café", date: "2026-10-10", accountId: nubank.id });
    const owner = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const wife = await createSession({ userId: fam.wifeCtx.userId!, householdId: fam.householdId });
    const h = (token: string) => ({ cookie: `fa_session=${token}`, origin: "http://localhost:3000" });
    const tx = await import("@/app/api/v1/exports/transactions/route");
    const full = await import("@/app/api/v1/exports/full/route");
    const delAccount = await import("@/app/api/v1/privacy/delete-my-account/route");
    const delHousehold = await import("@/app/api/v1/privacy/delete-household/route");
    const none = { params: Promise.resolve({}) };

    const q = encodeURIComponent(JSON.stringify({ start: "2026-10-01", end: "2026-10-31" }));
    const csv = await tx.GET(new NextRequest(`http://localhost:3000/api/v1/exports/transactions?format=csv&q=${q}`, { headers: h(owner.token) }), none);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="transacoes-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.headers.get("x-export-rows")).toBe("1");
    expect((await csv.text()).split("\r\n")[1]).toContain("Café");
    const xlsx = await tx.GET(new NextRequest("http://localhost:3000/api/v1/exports/transactions?format=xlsx", { headers: h(owner.token) }), none);
    expect(xlsx.headers.get("content-type")).toContain("spreadsheetml");

    const json = await full.GET(new NextRequest("http://localhost:3000/api/v1/exports/full", { headers: h(owner.token) }), none);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.text()).not.toContain("passwordHash");

    const ownerDelete = await delAccount.POST(
      new NextRequest("http://localhost:3000/api/v1/privacy/delete-my-account", { method: "POST", body: JSON.stringify({ confirmation: "EXCLUIR" }), headers: { ...h(owner.token), "content-type": "application/json" } }),
      none,
    );
    expect(ownerDelete.status).toBe(422);
    const memberHousehold = await delHousehold.POST(
      new NextRequest("http://localhost:3000/api/v1/privacy/delete-household", { method: "POST", body: JSON.stringify({ confirmation: "Família Teste" }), headers: { ...h(wife.token), "content-type": "application/json" } }),
      none,
    );
    expect(memberHousehold.status).toBe(403);
    const res = await delAccount.POST(
      new NextRequest("http://localhost:3000/api/v1/privacy/delete-my-account", { method: "POST", body: JSON.stringify({ confirmation: "EXCLUIR" }), headers: { ...h(wife.token), "content-type": "application/json" } }),
      none,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/fa_session=;/);
    // A sessão da esposa deixou de valer.
    const after = await tx.GET(new NextRequest("http://localhost:3000/api/v1/exports/transactions", { headers: h(wife.token) }), none);
    expect(after.status).toBe(401);
  });
});

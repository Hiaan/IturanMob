import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import { addDays, todayISO } from "@/lib/dates";
import { createTransaction } from "@/server/modules/transactions/service";
import { commitImport, getImportPreview } from "@/server/modules/imports/service";
import {
  addBankItem,
  getOpenFinanceStatus,
  removeOpenFinanceConnection,
  runOpenFinanceJobs,
  saveOpenFinanceCredentials,
  syncHousehold,
  syncNow,
  updateBankLink,
  updateOpenFinanceSettings,
} from "@/server/modules/open-finance/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";

/**
 * Conexão com bancos pelo Meu Pluggy, com a API da Pluggy falsa (fetch simulado): credenciais
 * conferidas antes de salvar e cifradas, banco por ID da conexão, vínculo das contas/cartões,
 * lançamentos pela prévia da importação (pendentes esperam, pagamento de fatura fora, parcela
 * marcada), nada duplicado em novas buscas, importação direta opcional e conexão com problema.
 */

const TZ = "America/Recife";
const ITEM = "0f6c7b1e-1111-4a2b-9c3d-aaaaaaaaaaaa";
const CLIENT_ID = "client-id-teste-1234";
const SECRET = "segredo-muito-secreto-XYZ";

interface FakeTx {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: "DEBIT" | "CREDIT";
  status?: "POSTED" | "PENDING";
  currencyCode?: string;
  creditCardMetadata?: { installmentNumber: number; totalInstallments: number } | null;
}

const api = {
  itemStatus: "UPDATED",
  tx: new Map<string, FakeTx[]>(),
  calls: [] as string[],
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  api.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.pathname === "/auth") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { clientId?: string; clientSecret?: string };
    return body.clientId === CLIENT_ID && body.clientSecret === SECRET ? json(200, { apiKey: "api-key-temporaria" }) : json(401, { message: "Invalid credentials", code: 401 });
  }
  const headers = new Headers(init?.headers);
  if (headers.get("X-API-KEY") !== "api-key-temporaria") return json(401, { message: "Unauthorized" });
  if (url.pathname === `/items/${ITEM}`) {
    return json(200, { id: ITEM, status: api.itemStatus, connector: { name: "Nubank" }, lastUpdatedAt: "2026-10-20T06:00:00.000Z", error: api.itemStatus === "LOGIN_ERROR" ? { message: "Senha alterada" } : null });
  }
  if (url.pathname.startsWith("/items/")) return json(404, { message: "Item not found" });
  if (url.pathname === "/accounts") {
    return json(200, {
      results: [
        { id: "acc-conta", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta Nubank", number: "0001234-5", balance: 1520.35, currencyCode: "BRL" },
        { id: "acc-cartao", type: "CREDIT", subtype: "CREDIT_CARD", name: "Nubank Ultravioleta", number: "5162********4321", balance: 845.9, currencyCode: "BRL" },
      ],
    });
  }
  if (url.pathname === "/v2/transactions") {
    const accountId = url.searchParams.get("accountId")!;
    const from = url.searchParams.get("dateFrom")!;
    const all = (api.tx.get(accountId) ?? []).filter((t) => t.date.slice(0, 10) >= from);
    // Duas páginas para exercitar o cursor.
    const after = url.searchParams.get("after");
    const page = after ? all.slice(2) : all.slice(0, 2);
    return json(200, { results: page.map((t) => ({ status: "POSTED", currencyCode: "BRL", creditCardMetadata: null, ...t })), next: !after && all.length > 2 ? `/v2/transactions?after=cursor2` : null });
  }
  return json(404, { message: "not found" });
});

const day = (offset: number) => `${addDays(todayISO(TZ), offset)}T15:00:00.000Z`;

async function setup() {
  const fam = await createFamily();
  await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
  const accounts = await createBasicAccounts(fam.ctx);
  await prisma.creditCard.update({ where: { id: accounts.card.id }, data: { last4: "4321" } });
  return { fam, ...accounts };
}

describe("Open Finance (Meu Pluggy)", () => {
  beforeEach(async () => {
    await resetDatabase();
    api.itemStatus = "UPDATED";
    api.tx = new Map();
    api.calls = [];
    vi.stubGlobal("fetch", fakeFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("credenciais: conferidas antes de salvar, cifradas e nunca devolvidas; simulador desligado", async () => {
    const { fam } = await setup();
    await expect(saveOpenFinanceCredentials(fam.ctx, { provider: "PLUGGY", clientId: CLIENT_ID, clientSecret: "errado" })).rejects.toThrow(/confira o Client ID e o Client Secret/);
    expect(await prisma.bankConnection.count()).toBe(0);
    await expect(saveOpenFinanceCredentials(fam.ctx, { provider: "SIMULATOR" })).rejects.toThrow(/simulador de bancos está desligado/);

    const status = await saveOpenFinanceCredentials(fam.ctx, { provider: "PLUGGY", clientId: CLIENT_ID, clientSecret: SECRET });
    expect(status).toMatchObject({ configured: true, provider: "PLUGGY", simulated: false, clientIdHint: "…1234", autoImport: false, initialDays: 30, items: [] });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const conn = await prisma.bankConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } });
    expect(conn.clientIdEnc).not.toContain(CLIENT_ID);
    expect(conn.clientSecretEnc).not.toContain(SECRET);
    // Campo vazio mantém o segredo salvo (confere de novo com o salvo).
    await expect(saveOpenFinanceCredentials(fam.ctx, { provider: "PLUGGY" })).resolves.toMatchObject({ configured: true });
    const audits = await prisma.auditLog.findMany({ where: { householdId: fam.householdId, entityType: "BankConnection" } });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it("banco pelo ID: contas e cartões, vínculo, prévia sem duplicar, pendentes esperam", async () => {
    const { fam, itau, nubank, card } = await setup();
    await saveOpenFinanceCredentials(fam.ctx, { provider: "PLUGGY", clientId: CLIENT_ID, clientSecret: SECRET });
    await expect(addBankItem(fam.ctx, { itemId: "11111111-2222-3333-4444-555555555555" })).rejects.toThrow(/Não encontrado/);
    const status = await addBankItem(fam.ctx, { itemId: ITEM });
    expect(status.items).toHaveLength(1);
    expect(status.items[0]).toMatchObject({ institutionName: "Nubank", status: "UPDATED", needsAttention: false });
    const [contaLink, cartaoLink] = status.items[0]!.accounts;
    expect(contaLink).toMatchObject({ type: "BANK", name: "Conta Nubank", numberLast4: "2345", balanceCents: 152_035, account: null });
    // Cartão do app com o mesmo final: já ligado.
    expect(cartaoLink).toMatchObject({ type: "CREDIT", numberLast4: "4321", balanceCents: 84_590, creditCard: { id: card.id } });
    await expect(addBankItem(fam.ctx, { itemId: ITEM })).rejects.toThrow(/já está conectado/);
    await expect(updateBankLink(fam.ctx, contaLink!.id, { creditCardId: card.id })).rejects.toThrow(/se liga a uma conta do app/);
    await updateBankLink(fam.ctx, contaLink!.id, { accountId: nubank.id });
    await expect(updateBankLink(fam.ctx, cartaoLink!.id, { accountId: itau.id })).rejects.toThrow(/se liga a um cartão do app/);

    // Lançamento já registrado à mão no app: vira "já registrado" (não duplica).
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 4_590, description: "Padaria Dourada", date: addDays(todayISO(TZ), -3), accountId: nubank.id });
    api.tx.set("acc-conta", [
      { id: "t1", date: day(-5), description: "Pix recebido Maria", amount: 300, type: "CREDIT" },
      { id: "t2", date: day(-3), description: "PADARIA DOURADA", amount: -45.9, type: "DEBIT" },
      { id: "t3", date: day(-2), description: "Conta de luz", amount: -187.43, type: "DEBIT" },
      { id: "t4", date: day(-1), description: "Compra pendente", amount: -20, type: "DEBIT", status: "PENDING" },
      { id: "t5", date: day(-1), description: "Compra em dólar", amount: -10, type: "DEBIT", currencyCode: "USD" },
    ]);
    api.tx.set("acc-cartao", [
      { id: "c1", date: day(-6), description: "Loja de Móveis", amount: 250, type: "DEBIT", creditCardMetadata: { installmentNumber: 2, totalInstallments: 6 } },
      { id: "c2", date: day(-4), description: "Pagamento recebido", amount: -1200, type: "CREDIT" },
      { id: "c3", date: day(-2), description: "Streaming", amount: 55.9, type: "DEBIT" },
    ]);

    const first = await syncNow(fam.ctx);
    expect(first.errors).toEqual([]);
    const conta = first.links.find((l) => l.name === "Conta Nubank")!;
    expect(conta).toMatchObject({ fetched: 5, pending: 1, foreign: 1, newRows: 3, imported: null });
    const cartao = first.links.find((l) => l.name === "Nubank Ultravioleta")!;
    expect(cartao).toMatchObject({ fetched: 3, newRows: 3 });
    await expect(syncNow(fam.ctx)).rejects.toThrow(/Aguarde 1 minuto/);

    const contaPreview = await getImportPreview(fam.ctx, conta.batchId!);
    expect(contaPreview.batch).toMatchObject({ format: "OPEN_FINANCE", status: "PREVIEW", account: { id: nubank.id } });
    const byDesc = Object.fromEntries(contaPreview.rows.map((r) => [r.description, r]));
    expect(byDesc["Pix recebido Maria"]).toMatchObject({ status: "NEW", amountCents: 30_000 });
    expect(byDesc["PADARIA DOURADA"]).toMatchObject({ status: "MATCHED" });
    expect(byDesc["Conta de luz"]).toMatchObject({ status: "NEW", amountCents: -18_743 });
    const cardPreview = await getImportPreview(fam.ctx, cartao.batchId!);
    const cardRows = Object.fromEntries(cardPreview.rows.map((r) => [r.description, r]));
    expect(cardRows["Loja de Móveis PARC 02/06"]).toMatchObject({ amountCents: -25_000 });
    expect(cardRows["Pagamento recebido"]).toMatchObject({ status: "SKIPPED" });
    expect(cardRows["Streaming"]).toMatchObject({ status: "NEW", amountCents: -5_590 });
    const notes = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "BANK_SYNC", channel: "IN_APP" } });
    expect(notes.map((n) => n.title)).toContain("3 lançamento(s) do banco para conferir");
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(1);

    // Nova busca (mesmos lançamentos + a compra que deixou de ser pendente): só a nova entra.
    api.tx.get("acc-conta")![3]!.status = "POSTED";
    const second = await syncHousehold(fam.householdId);
    expect(second.links.find((l) => l.name === "Conta Nubank")).toMatchObject({ newRows: 1 });
    expect(second.links.find((l) => l.name === "Nubank Ultravioleta")).toMatchObject({ newRows: 0, batchId: null });

    // Confirmar as prévias e buscar de novo: nada duplica.
    await commitImport(fam.ctx, conta.batchId!);
    await commitImport(fam.ctx, second.links.find((l) => l.name === "Conta Nubank")!.batchId!);
    const txCount = await prisma.transaction.count({ where: { householdId: fam.householdId, deletedAt: null } });
    expect(txCount).toBe(1 + 2 + 1); // padaria (manual, conciliada) + pix + luz + compra
    const third = await syncHousehold(fam.householdId);
    expect(third.links.every((l) => l.newRows === 0)).toBe(true);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, deletedAt: null } })).toBe(txCount);
    // Nenhum segredo nas chamadas além do /auth.
    expect(api.calls.filter((c) => c.includes("auth"))).not.toHaveLength(0);
  });

  it("importar direto (opcional), conexão com problema avisa e não busca, remover mantém lançamentos", async () => {
    const { fam, nubank } = await setup();
    await saveOpenFinanceCredentials(fam.ctx, { provider: "PLUGGY", clientId: CLIENT_ID, clientSecret: SECRET });
    const status = await addBankItem(fam.ctx, { itemId: ITEM });
    await updateBankLink(fam.ctx, status.items[0]!.accounts[0]!.id, { accountId: nubank.id });
    await updateBankLink(fam.ctx, status.items[0]!.accounts[1]!.id, { enabled: false });
    await updateOpenFinanceSettings(fam.ctx, { autoImport: true, initialDays: 10 });
    api.tx.set("acc-conta", [
      { id: "a1", date: day(-20), description: "Antigo demais", amount: -99, type: "DEBIT" },
      { id: "a2", date: day(-2), description: "Mercado", amount: -120.5, type: "DEBIT" },
    ]);
    const res = await runOpenFinanceJobs();
    expect(res).toMatchObject({ households: 1, errors: 0 });
    expect(await prisma.transaction.findMany({ where: { householdId: fam.householdId }, select: { description: true, amountCents: true, source: true } })).toEqual([
      expect.objectContaining({ description: "Mercado", amountCents: 12_050 }),
    ]);
    expect((await prisma.notification.findFirstOrThrow({ where: { householdId: fam.householdId, type: "BANK_SYNC" } })).title).toBe("1 lançamento(s) do banco importado(s)");
    // Logo depois: a busca periódica espera 6 horas.
    expect(await runOpenFinanceJobs()).toMatchObject({ households: 0 });

    api.itemStatus = "LOGIN_ERROR";
    const broken = await syncHousehold(fam.householdId);
    expect(broken.errors[0]).toContain("precisa ser refeita no Meu Pluggy");
    expect(broken.links).toEqual([]);
    const st = await getOpenFinanceStatus(fam.ctx);
    expect(st.items[0]).toMatchObject({ status: "LOGIN_ERROR", needsAttention: true });
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, type: "BANK_SYNC", title: { contains: "precisa de atenção" }, channel: "IN_APP" } })).toBeGreaterThan(0);
    await syncHousehold(fam.householdId);
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, type: "BANK_SYNC", title: { contains: "precisa de atenção" }, recipientMemberId: fam.husbandId, channel: "IN_APP" } })).toBe(1);

    expect(await removeOpenFinanceConnection(fam.ctx)).toEqual({ removed: true });
    expect(await prisma.bankItem.count()).toBe(0);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(1);
  });
});

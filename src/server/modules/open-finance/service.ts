import { z } from "zod";
import type { BankAccountLink, BankConnection, BankItem } from "@prisma/client";
import { prisma } from "../../db";
import { systemContext, type ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { decryptStringSafe, encryptString } from "../../crypto";
import { env } from "../../env";
import { NotFoundError, ValidationError } from "../../errors";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { addDays, dateToISO, formatDateTimeBR, instantToISO, isoToDate, todayISO, type ISODate } from "@/lib/dates";
import { audit } from "../audit/service";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";
import { commitImport, createOpenFinanceBatch } from "../imports/service";
import type { ParsedImportRow } from "../imports/types";
import { detectInstallment } from "../imports/matching";
import { getVisibilityScope } from "../visibility/scope";
import { OpenFinanceError, PluggyClient, SimulatedOpenFinanceClient, type OpenFinanceClient, type OFTransaction } from "../../integrations/open-finance/pluggy";

/**
 * Conexão com bancos (Open Finance) pelo Meu Pluggy — gratuito para uso pessoal, até 5 bancos por
 * CPF, dados atualizados 1x por dia; não pode ser usado para fins comerciais ou para terceiros.
 *
 * Só leitura. Os lançamentos entram pela mesma prévia da importação de arquivos (duplicados, já
 * registrados, parcelas, pagamento de fatura e regras), com o id do banco como identificador: o
 * mesmo lançamento nunca entra duas vezes. Por padrão viram uma prévia para conferir; a família pode
 * escolher importar direto. Lançamentos ainda "pendentes" no banco esperam até serem confirmados.
 */

export const OF_MAX_ITEMS = 5;
const SYNC_EVERY_MS = 6 * 3_600_000;
const MANUAL_MIN_INTERVAL_MS = 60_000;
/** A próxima busca começa alguns dias antes do último lançamento trazido (o banco às vezes atrasa). */
const OVERLAP_DAYS = 5;
const ERROR_STATUSES = new Set(["LOGIN_ERROR", "OUTDATED", "WAITING_USER_INPUT", "WAITING_USER_ACTION"]);

const EXTERNAL_PREFIX = "of:";

function simulatorAvailable() {
  return env().OPEN_FINANCE_SIMULATOR;
}

/** Cliente para a conexão (credenciais decifradas só em memória). */
export function clientFor(conn: Pick<BankConnection, "provider" | "clientIdEnc" | "clientSecretEnc">): OpenFinanceClient {
  if (conn.provider === "SIMULATOR") {
    if (!simulatorAvailable()) throw new ValidationError("O simulador de bancos está desligado neste servidor.");
    return new SimulatedOpenFinanceClient();
  }
  const id = decryptStringSafe(conn.clientIdEnc);
  const secret = decryptStringSafe(conn.clientSecretEnc);
  if (!id || !secret) throw new ValidationError("Informe o Client ID e o Client Secret da Pluggy.");
  return new PluggyClient(id, secret);
}

/** Erro da Pluggy → mensagem para a pessoa (sem dados sensíveis). */
function friendly(err: unknown): string {
  if (err instanceof OpenFinanceError || err instanceof ValidationError) return err.message;
  return "Falha inesperada ao falar com o banco.";
}

// -----------------------------------------------------------------------------
// Situação e configuração
// -----------------------------------------------------------------------------

export interface BankLinkDTO {
  id: string;
  type: "BANK" | "CREDIT";
  name: string;
  numberLast4: string | null;
  currency: string;
  /** Saldo (conta) ou fatura atual (cartão) informado pelo banco. */
  balanceCents: number | null;
  balanceAt: string | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string } | null;
  enabled: boolean;
  lastSyncAt: string | null;
  lastTransactionDate: string | null;
}

export interface BankItemDTO {
  id: string;
  itemId: string;
  institutionName: string | null;
  status: string | null;
  needsAttention: boolean;
  providerUpdatedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  accounts: BankLinkDTO[];
}

export interface OpenFinanceStatusDTO {
  configured: boolean;
  provider: "PLUGGY" | "SIMULATOR" | null;
  simulated: boolean;
  simulatorAvailable: boolean;
  /** Final do Client ID (para conferir qual aplicação está salva). */
  clientIdHint: string | null;
  autoImport: boolean;
  initialDays: number;
  lastSyncAt: string | null;
  lastError: string | null;
  maxItems: number;
  items: BankItemDTO[];
}

type LinkRow = BankAccountLink & { account: { id: string; name: string } | null; creditCard: { id: string; name: string } | null };

function linkDTO(l: LinkRow): BankLinkDTO {
  return {
    id: l.id,
    type: l.type === "CREDIT" ? "CREDIT" : "BANK",
    name: l.name,
    numberLast4: l.numberLast4,
    currency: l.currency,
    balanceCents: l.balanceCents,
    balanceAt: l.balanceAt?.toISOString() ?? null,
    account: l.account,
    creditCard: l.creditCard,
    enabled: l.enabled,
    lastSyncAt: l.lastSyncAt?.toISOString() ?? null,
    lastTransactionDate: l.lastTransactionDate ? dateToISO(l.lastTransactionDate) : null,
  };
}

export async function getOpenFinanceStatus(ctx: ServiceContext): Promise<OpenFinanceStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const conn = await prisma.bankConnection.findUnique({ where: { householdId: ctx.householdId } });
  const scope = await getVisibilityScope(ctx);
  const items = conn
    ? await prisma.bankItem.findMany({
        where: { householdId: ctx.householdId },
        orderBy: { createdAt: "asc" },
        include: { accounts: { orderBy: { createdAt: "asc" }, include: { account: { select: { id: true, name: true } }, creditCard: { select: { id: true, name: true } } } } },
      })
    : [];
  const clientId = conn ? decryptStringSafe(conn.clientIdEnc) : null;
  return {
    configured: Boolean(conn && (conn.provider === "SIMULATOR" || conn.clientIdEnc)),
    provider: conn?.provider ?? null,
    simulated: conn?.provider === "SIMULATOR",
    simulatorAvailable: simulatorAvailable(),
    clientIdHint: clientId ? `…${clientId.slice(-4)}` : null,
    autoImport: conn?.autoImport ?? false,
    initialDays: conn?.initialDays ?? 30,
    lastSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
    lastError: conn?.lastError ?? null,
    maxItems: OF_MAX_ITEMS,
    items: items.map((it) => ({
      id: it.id,
      itemId: it.itemId,
      institutionName: it.institutionName,
      status: it.status,
      needsAttention: Boolean(it.status && ERROR_STATUSES.has(it.status)) || Boolean(it.lastError),
      providerUpdatedAt: it.providerUpdatedAt?.toISOString() ?? null,
      lastSyncAt: it.lastSyncAt?.toISOString() ?? null,
      lastError: it.lastError,
      // Contas/cartões privados de outra pessoa: o nome do destino no app fica oculto.
      accounts: it.accounts.map((l) =>
        linkDTO({
          ...l,
          account: l.account && scope.hiddenAccountIds.includes(l.account.id) ? { id: l.account.id, name: "Conta privada" } : l.account,
          creditCard: l.creditCard && scope.hiddenCardIds.includes(l.creditCard.id) ? { id: l.creditCard.id, name: "Cartão privado" } : l.creditCard,
        }),
      ),
    })),
  };
}

export const openFinanceCredentialsSchema = z.object({
  provider: z.enum(["PLUGGY", "SIMULATOR"]).default("PLUGGY"),
  clientId: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(500).optional(),
});

/** Salva (e confere na Pluggy) as credenciais da aplicação. Sem conferir, nada é salvo. */
export async function saveOpenFinanceCredentials(ctx: ServiceContext, raw: z.input<typeof openFinanceCredentialsSchema>): Promise<OpenFinanceStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const input = openFinanceCredentialsSchema.parse(raw);
  const current = await prisma.bankConnection.findUnique({ where: { householdId: ctx.householdId } });
  if (input.provider === "SIMULATOR") {
    if (!simulatorAvailable()) throw new ValidationError("O simulador de bancos está desligado neste servidor.");
    if (current?.provider === "PLUGGY" && (await prisma.bankItem.count({ where: { householdId: ctx.householdId } }))) {
      throw new ValidationError("Remova os bancos conectados antes de trocar para o simulador.");
    }
  } else {
    if (current?.provider === "SIMULATOR" && (await prisma.bankItem.count({ where: { householdId: ctx.householdId } }))) {
      throw new ValidationError("Remova os bancos simulados antes de usar a Pluggy de verdade.");
    }
  }
  let clientIdEnc = current?.clientIdEnc ?? null;
  let clientSecretEnc = current?.clientSecretEnc ?? null;
  if (input.provider === "PLUGGY") {
    // Campo vazio mantém o valor salvo (o segredo nunca volta para a tela).
    const clientId = input.clientId || decryptStringSafe(current?.clientIdEnc);
    const clientSecret = input.clientSecret || decryptStringSafe(current?.clientSecretEnc);
    if (!clientId || !clientSecret) throw new ValidationError("Informe o Client ID e o Client Secret da aplicação criada no painel da Pluggy.");
    try {
      await new PluggyClient(clientId, clientSecret).verify();
    } catch (err) {
      throw new ValidationError(friendly(err));
    }
    clientIdEnc = encryptString(clientId);
    clientSecretEnc = encryptString(clientSecret);
  } else {
    clientIdEnc = null;
    clientSecretEnc = null;
  }
  await prisma.bankConnection.upsert({
    where: { householdId: ctx.householdId },
    create: { householdId: ctx.householdId, provider: input.provider, clientIdEnc, clientSecretEnc },
    update: { provider: input.provider, clientIdEnc, clientSecretEnc, lastError: null },
  });
  await audit(ctx, { action: "UPDATE", entityType: "BankConnection", entityId: ctx.householdId, after: { provider: input.provider, credentials: input.provider === "PLUGGY" ? "atualizadas (cifradas)" : null } });
  return getOpenFinanceStatus(ctx);
}

export const openFinanceSettingsSchema = z.object({
  autoImport: z.boolean().optional(),
  initialDays: z.number().int().min(1).max(365).optional(),
});

export async function updateOpenFinanceSettings(ctx: ServiceContext, raw: z.input<typeof openFinanceSettingsSchema>): Promise<OpenFinanceStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const input = openFinanceSettingsSchema.parse(raw);
  const conn = await prisma.bankConnection.findUnique({ where: { householdId: ctx.householdId } });
  if (!conn) throw new ValidationError("Configure a conexão com a Pluggy primeiro.");
  await prisma.bankConnection.update({ where: { id: conn.id }, data: input });
  await audit(ctx, { action: "UPDATE", entityType: "BankConnection", entityId: conn.id, before: { autoImport: conn.autoImport, initialDays: conn.initialDays }, after: input });
  return getOpenFinanceStatus(ctx);
}

/** Remove a conexão (credenciais, bancos e vínculos). Lançamentos já importados continuam no app. */
export async function removeOpenFinanceConnection(ctx: ServiceContext): Promise<{ removed: boolean }> {
  assertCan(ctx, "integrations:manage");
  const conn = await prisma.bankConnection.findUnique({ where: { householdId: ctx.householdId } });
  if (!conn) return { removed: false };
  await prisma.bankConnection.delete({ where: { id: conn.id } });
  await audit(ctx, { action: "DELETE", entityType: "BankConnection", entityId: conn.id, before: { provider: conn.provider } });
  return { removed: true };
}

// -----------------------------------------------------------------------------
// Bancos (itens) e contas
// -----------------------------------------------------------------------------

export const addBankItemSchema = z.object({ itemId: z.string().trim().min(8, "Cole o ID da conexão").max(64) });

async function requireConnection(householdId: string): Promise<BankConnection> {
  const conn = await prisma.bankConnection.findUnique({ where: { householdId } });
  if (!conn || (conn.provider === "PLUGGY" && !conn.clientIdEnc)) throw new ValidationError("Configure a conexão com a Pluggy primeiro.");
  return conn;
}

/** Atualiza a situação do banco e a lista de contas/cartões dele (sem trazer lançamentos). */
async function refreshItem(client: OpenFinanceClient, item: BankItem, opts: { cards: Array<{ id: string; last4: string | null }> } | null = null) {
  const info = await client.getItem(item.itemId);
  await prisma.bankItem.update({
    where: { id: item.id },
    data: { institutionName: info.institutionName, status: info.status, providerUpdatedAt: info.lastUpdatedAt ? new Date(info.lastUpdatedAt) : null, lastError: info.errorMessage },
  });
  const accounts = await client.listAccounts(item.itemId);
  for (const a of accounts) {
    // Cartão do app com os mesmos 4 últimos dígitos: já sugere o vínculo.
    const card = a.type === "CREDIT" && a.numberLast4 && opts ? opts.cards.filter((c) => c.last4 === a.numberLast4) : [];
    await prisma.bankAccountLink.upsert({
      where: { householdId_externalAccountId: { householdId: item.householdId, externalAccountId: a.id } },
      create: {
        householdId: item.householdId,
        bankItemId: item.id,
        externalAccountId: a.id,
        type: a.type,
        subtype: a.subtype,
        name: a.name,
        numberLast4: a.numberLast4,
        currency: a.currency,
        balanceCents: a.balanceCents,
        balanceAt: new Date(),
        creditCardId: card.length === 1 ? card[0]!.id : null,
      },
      update: { name: a.name, subtype: a.subtype, numberLast4: a.numberLast4, currency: a.currency, balanceCents: a.balanceCents, balanceAt: new Date() },
    });
  }
  return info;
}

export async function addBankItem(ctx: ServiceContext, raw: z.input<typeof addBankItemSchema>): Promise<OpenFinanceStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const { itemId } = addBankItemSchema.parse(raw);
  const conn = await requireConnection(ctx.householdId);
  const existing = await prisma.bankItem.findUnique({ where: { householdId_itemId: { householdId: ctx.householdId, itemId } } });
  if (existing) throw new ValidationError("Este banco já está conectado.");
  if ((await prisma.bankItem.count({ where: { householdId: ctx.householdId } })) >= OF_MAX_ITEMS) {
    throw new ValidationError(`O Meu Pluggy gratuito permite até ${OF_MAX_ITEMS} bancos.`);
  }
  const client = clientFor(conn);
  try {
    await client.getItem(itemId);
  } catch (err) {
    throw new ValidationError(friendly(err));
  }
  const item = await prisma.bankItem.create({ data: { householdId: ctx.householdId, connectionId: conn.id, itemId } });
  const scope = await getVisibilityScope(ctx);
  const cards = await prisma.creditCard.findMany({ where: { householdId: ctx.householdId, archivedAt: null, id: { notIn: scope.hiddenCardIds } }, select: { id: true, last4: true } });
  try {
    await refreshItem(client, item, { cards });
  } catch (err) {
    await prisma.bankItem.update({ where: { id: item.id }, data: { lastError: friendly(err) } });
  }
  await audit(ctx, { action: "CREATE", entityType: "BankItem", entityId: item.id, after: { simulated: client.simulated } });
  return getOpenFinanceStatus(ctx);
}

export async function removeBankItem(ctx: ServiceContext, id: string): Promise<OpenFinanceStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const item = await prisma.bankItem.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!item) throw new NotFoundError("Banco");
  await prisma.bankItem.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "BankItem", entityId: id, before: { institutionName: item.institutionName } });
  return getOpenFinanceStatus(ctx);
}

export const updateBankLinkSchema = z.object({
  accountId: z.string().min(1).nullish(),
  creditCardId: z.string().min(1).nullish(),
  enabled: z.boolean().optional(),
});

/** Liga a conta do banco a uma conta do app (ou o cartão do banco a um cartão do app). */
export async function updateBankLink(ctx: ServiceContext, id: string, raw: z.input<typeof updateBankLinkSchema>): Promise<OpenFinanceStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const input = updateBankLinkSchema.parse(raw);
  const link = await prisma.bankAccountLink.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!link) throw new NotFoundError("Conta do banco");
  const scope = await getVisibilityScope(ctx);
  const data: { accountId?: string | null; creditCardId?: string | null; enabled?: boolean } = {};
  if (input.accountId !== undefined) {
    if (link.type === "CREDIT" && input.accountId) throw new ValidationError("Cartão do banco se liga a um cartão do app, não a uma conta.");
    if (input.accountId) {
      const acc = await prisma.account.findFirst({ where: { id: input.accountId, householdId: ctx.householdId, archivedAt: null }, select: { id: true } });
      if (!acc || scope.hiddenAccountIds.includes(acc.id)) throw new ValidationError("Conta inválida.");
      const taken = await prisma.bankAccountLink.findFirst({ where: { householdId: ctx.householdId, accountId: acc.id, id: { not: id } }, select: { id: true } });
      if (taken) throw new ValidationError("Esta conta do app já está ligada a outra conta do banco.");
    }
    data.accountId = input.accountId ?? null;
  }
  if (input.creditCardId !== undefined) {
    if (link.type === "BANK" && input.creditCardId) throw new ValidationError("Conta do banco se liga a uma conta do app, não a um cartão.");
    if (input.creditCardId) {
      const card = await prisma.creditCard.findFirst({ where: { id: input.creditCardId, householdId: ctx.householdId, archivedAt: null }, select: { id: true } });
      if (!card || scope.hiddenCardIds.includes(card.id)) throw new ValidationError("Cartão inválido.");
      const taken = await prisma.bankAccountLink.findFirst({ where: { householdId: ctx.householdId, creditCardId: card.id, id: { not: id } }, select: { id: true } });
      if (taken) throw new ValidationError("Este cartão do app já está ligado a outro cartão do banco.");
    }
    data.creditCardId = input.creditCardId ?? null;
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  // Mudou o destino: a próxima busca recomeça do período inicial (o anti-duplicação evita repetir).
  const retarget = (data.accountId !== undefined && data.accountId !== link.accountId) || (data.creditCardId !== undefined && data.creditCardId !== link.creditCardId);
  await prisma.bankAccountLink.update({ where: { id }, data: { ...data, ...(retarget ? { lastTransactionDate: null } : {}) } });
  await audit(ctx, { action: "UPDATE", entityType: "BankAccountLink", entityId: id, before: { accountId: link.accountId, creditCardId: link.creditCardId, enabled: link.enabled }, after: data });
  return getOpenFinanceStatus(ctx);
}

// -----------------------------------------------------------------------------
// Sincronização
// -----------------------------------------------------------------------------

/** Lançamento do banco → linha da prévia de importação. */
export function toImportRow(t: OFTransaction, timezone: string, isCard: boolean): ParsedImportRow {
  const date = instantToISO(new Date(t.date), timezone);
  let description = t.description;
  // Parcela informada pelo banco: marcação "PARC 02/10" (a mesma das faturas em arquivo).
  if (isCard && t.installment && !detectInstallment(description)) {
    description = `${description} PARC ${String(t.installment.number).padStart(2, "0")}/${String(t.installment.total).padStart(2, "0")}`;
  }
  return {
    rowIndex: 0,
    date,
    amountCents: t.direction === "OUT" ? -t.amountCents : t.amountCents,
    description,
    externalId: `${EXTERNAL_PREFIX}${t.id}`.slice(0, 120),
    categoryName: null,
    raw: { origem: "Open Finance", ...(t.merchantName ? { estabelecimento: t.merchantName } : {}) },
    error: null,
    skipReason: null,
    meta: {},
  };
}

export interface LinkSyncResult {
  linkId: string;
  name: string;
  fetched: number;
  newRows: number;
  pending: number;
  foreign: number;
  batchId: string | null;
  imported: number | null;
}

export interface SyncSummary {
  items: number;
  links: LinkSyncResult[];
  errors: string[];
}

const running = new Set<string>();

async function syncLink(ctx: ServiceContext, client: OpenFinanceClient, conn: BankConnection, link: BankAccountLink, today: ISODate): Promise<LinkSyncResult> {
  const result: LinkSyncResult = { linkId: link.id, name: link.name, fetched: 0, newRows: 0, pending: 0, foreign: 0, batchId: null, imported: null };
  const from = link.lastTransactionDate ? addDays(dateToISO(link.lastTransactionDate), -OVERLAP_DAYS) : addDays(today, -conn.initialDays);
  const txs = await client.listTransactions(link.externalAccountId, from, today);
  result.fetched = txs.length;
  const posted = txs.filter((t) => {
    if (t.status === "PENDING") {
      result.pending++;
      return false;
    }
    if (t.currency !== "BRL") {
      result.foreign++;
      return false;
    }
    return true;
  });
  // Já trazidos antes (em qualquer prévia ou importação): nunca entram de novo.
  const ids = posted.map((t) => `${EXTERNAL_PREFIX}${t.id}`.slice(0, 120));
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await prisma.importRow.findMany({ where: { householdId: ctx.householdId, externalId: { in: ids.slice(i, i + 1000) } }, select: { externalId: true } });
    for (const r of rows) if (r.externalId) seen.add(r.externalId);
  }
  const fresh = posted.filter((t) => !seen.has(`${EXTERNAL_PREFIX}${t.id}`.slice(0, 120)));
  const isCard = link.type === "CREDIT";
  const rows = fresh.map((t) => toImportRow(t, ctx.timezone, isCard)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  result.newRows = rows.length;
  const latest = posted.reduce<ISODate | null>((m, t) => {
    const d = instantToISO(new Date(t.date), ctx.timezone);
    return !m || d > m ? d : m;
  }, null);
  if (rows.length) {
    const label = `${link.name}${link.numberLast4 ? ` ••${link.numberLast4}` : ""} — banco (${formatDateTimeBR(new Date(), ctx.timezone)})`;
    result.batchId = await createOpenFinanceBatch(ctx, { label, accountId: link.accountId, creditCardId: link.creditCardId, rows });
    if (result.batchId && conn.autoImport) {
      const committed = await commitImport(ctx, result.batchId);
      result.imported = committed.result.created;
    }
  }
  await prisma.bankAccountLink.update({
    where: { id: link.id },
    data: { lastSyncAt: new Date(), ...(latest && (!link.lastTransactionDate || latest > dateToISO(link.lastTransactionDate)) ? { lastTransactionDate: isoToDate(latest) } : {}) },
  });
  return result;
}

async function privacyFor(householdId: string, link: BankAccountLink): Promise<{ recipientMemberIds?: string[]; inAppOnly: boolean }> {
  if (link.creditCardId) {
    const c = await prisma.creditCard.findUnique({ where: { id: link.creditCardId }, select: { visibility: true, holderMemberId: true } });
    if (c?.visibility === "PRIVATE") return { recipientMemberIds: c.holderMemberId ? [c.holderMemberId] : [], inAppOnly: true };
  } else if (link.accountId) {
    const a = await prisma.account.findUnique({ where: { id: link.accountId }, select: { visibility: true, ownerMemberId: true } });
    if (a?.visibility === "PRIVATE") return { recipientMemberIds: a.ownerMemberId ? [a.ownerMemberId] : [], inAppOnly: true };
  }
  return { inAppOnly: false };
}

/** Busca os lançamentos novos de todas as contas ligadas da família. */
export async function syncHousehold(householdId: string, opts: { manual?: boolean; now?: Date } = {}): Promise<SyncSummary> {
  const summary: SyncSummary = { items: 0, links: [], errors: [] };
  if (running.has(householdId)) throw new ValidationError("Já estou buscando os lançamentos do banco. Aguarde um pouco.");
  const conn = await prisma.bankConnection.findUnique({ where: { householdId } });
  if (!conn) throw new ValidationError("Configure a conexão com a Pluggy primeiro.");
  if (opts.manual && conn.lastSyncAt && Date.now() - conn.lastSyncAt.getTime() < MANUAL_MIN_INTERVAL_MS) {
    throw new ValidationError("A última busca foi agora há pouco. Aguarde 1 minuto.");
  }
  const household = await prisma.household.findUniqueOrThrow({ where: { id: householdId }, select: { timezone: true } });
  const ctx = systemContext(householdId, household.timezone);
  const today = todayISO(household.timezone, opts.now);
  running.add(householdId);
  try {
    const client = clientFor(conn);
    const items = await prisma.bankItem.findMany({ where: { householdId }, include: { accounts: true } });
    for (const item of items) {
      summary.items++;
      try {
        const info = await refreshItem(client, item);
        if (ERROR_STATUSES.has(info.status)) {
          const msg = `${info.institutionName ?? "Banco"}: a conexão precisa ser refeita no Meu Pluggy (${info.status}).`;
          summary.errors.push(msg);
          if (await claimAlertMark(householdId, `of:item:${item.id}:${info.status}:${info.lastUpdatedAt ?? ""}`)) {
            await notify({ householdId, type: "BANK_SYNC", title: `Conexão com ${info.institutionName ?? "o banco"} precisa de atenção`, body: `${msg} Entre em meu.pluggy.ai e reconecte o banco.`, dedupeKey: `of:item:${item.id}:${info.status}:${info.lastUpdatedAt ?? ""}`, data: { url: "/integracoes", stage: "ERROR" } });
          }
          continue;
        }
        const links = await prisma.bankAccountLink.findMany({ where: { bankItemId: item.id, enabled: true, OR: [{ accountId: { not: null } }, { creditCardId: { not: null } }] } });
        for (const link of links) {
          try {
            const res = await syncLink(ctx, client, conn, link, today);
            summary.links.push(res);
            if (res.batchId) {
              const privacy = await privacyFor(householdId, link);
              if (privacy.recipientMemberIds && !privacy.recipientMemberIds.length) continue;
              const auto = res.imported !== null;
              await notify({
                householdId,
                type: "BANK_SYNC",
                title: auto ? `${res.imported} lançamento(s) do banco importado(s)` : `${res.newRows} lançamento(s) do banco para conferir`,
                body: auto
                  ? `${link.name}: ${res.imported} lançamento(s) novo(s) entraram no app. Duplicados e já registrados ficaram de fora.`
                  : `${link.name}: ${res.newRows} lançamento(s) novo(s). Confira e confirme na importação.`,
                dedupeKey: `of:batch:${res.batchId}`,
                recipientMemberIds: privacy.recipientMemberIds,
                data: { url: `/importacao?batch=${res.batchId}`, importBatchId: res.batchId, stage: auto ? "IMPORTED" : "REVIEW", ...(privacy.inAppOnly ? { inAppOnly: true } : {}) },
              });
            }
          } catch (err) {
            summary.errors.push(`${link.name}: ${friendly(err)}`);
            logger.warn({ householdId, linkId: link.id, err: errorInfo(err).name }, "open-finance: falha ao buscar lançamentos da conta");
          }
        }
        await prisma.bankItem.update({ where: { id: item.id }, data: { lastSyncAt: new Date() } });
      } catch (err) {
        const msg = friendly(err);
        summary.errors.push(`${item.institutionName ?? "Banco"}: ${msg}`);
        await prisma.bankItem.update({ where: { id: item.id }, data: { lastError: msg } });
        logger.warn({ householdId, itemId: item.id, err: errorInfo(err).name }, "open-finance: falha ao atualizar o banco");
      }
    }
    await prisma.bankConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastError: summary.errors.length ? summary.errors.join(" · ").slice(0, 500) : null } });
  } finally {
    running.delete(householdId);
  }
  await publishEvent(householdId, "import.changed");
  return summary;
}

/** "Buscar agora" na tela de integrações. */
export async function syncNow(ctx: ServiceContext): Promise<SyncSummary> {
  assertCan(ctx, "integrations:manage");
  assertCan(ctx, "data:import");
  return syncHousehold(ctx.householdId, { manual: true });
}

/** Tarefa periódica: o Meu Pluggy atualiza 1x por dia; busca a cada 6 horas. */
export async function runOpenFinanceJobs(now: Date = new Date()): Promise<{ households: number; errors: number }> {
  const summary = { households: 0, errors: 0 };
  const conns = await prisma.bankConnection.findMany({
    where: { OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - SYNC_EVERY_MS) } }], household: { bankItems: { some: {} } } },
    select: { householdId: true, provider: true },
  });
  for (const c of conns) {
    if (c.provider === "SIMULATOR" && !simulatorAvailable()) continue;
    summary.households++;
    try {
      const res = await syncHousehold(c.householdId, { now });
      if (res.errors.length) summary.errors++;
    } catch (err) {
      summary.errors++;
      logger.warn({ householdId: c.householdId, err: errorInfo(err).name }, "open-finance: falha na busca periódica");
    }
  }
  return summary;
}

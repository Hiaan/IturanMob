import { env } from "../../env";

/**
 * Cliente da API da Pluggy (Open Finance). Uso com o Meu Pluggy: a pessoa conecta os próprios
 * bancos em meu.pluggy.ai e cria uma aplicação no painel da Pluggy; o app só LÊ contas e
 * lançamentos (nenhuma movimentação é feita). Client ID/Secret nunca vão para logs ou mensagens de
 * erro; a chave de acesso temporária (apiKey) fica só em memória.
 */

export interface OFItem {
  id: string;
  status: string;
  institutionName: string | null;
  lastUpdatedAt: string | null;
  errorMessage: string | null;
}

export interface OFAccount {
  id: string;
  type: "BANK" | "CREDIT";
  subtype: string | null;
  name: string;
  numberLast4: string | null;
  balanceCents: number | null;
  currency: string;
}

export interface OFTransaction {
  id: string;
  /** Data/hora informada pelo banco (ISO). */
  date: string;
  description: string;
  /** Valor sempre positivo; o sentido vem de `direction`. */
  amountCents: number;
  direction: "IN" | "OUT";
  status: "POSTED" | "PENDING";
  currency: string;
  installment: { number: number; total: number } | null;
  merchantName: string | null;
}

export interface OpenFinanceClient {
  readonly simulated: boolean;
  /** Confere as credenciais (gera a chave de acesso). */
  verify(): Promise<void>;
  getItem(itemId: string): Promise<OFItem>;
  listAccounts(itemId: string): Promise<OFAccount[]>;
  listTransactions(accountId: string, from: string, to: string): Promise<OFTransaction[]>;
}

export class OpenFinanceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "OpenFinanceError";
  }
}

const TIMEOUT_MS = 30_000;
/** Limite de lançamentos por conta numa sincronização (proteção contra respostas enormes). */
export const MAX_TRANSACTIONS_PER_SYNC = 3_000;

const toCents = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null);

function last4(number: unknown): string | null {
  const digits = typeof number === "string" ? number.replace(/\D/g, "") : "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Mensagem segura (sem dados da requisição) para um erro da API. */
function apiError(status: number, body: unknown): OpenFinanceError {
  const b = (body ?? {}) as { message?: unknown; code?: unknown; codeDescription?: unknown };
  const code = typeof b.codeDescription === "string" ? b.codeDescription : typeof b.code === "string" || typeof b.code === "number" ? String(b.code) : null;
  if (status === 401 || status === 403) {
    if (code === "LIST_ITEMS_FEATURE_NOT_ENABLED") return new OpenFinanceError("Recurso não liberado no plano gratuito da Pluggy.", status, code);
    return new OpenFinanceError("A Pluggy recusou o acesso: confira o Client ID e o Client Secret.", status, code);
  }
  if (status === 404) return new OpenFinanceError("Não encontrado na Pluggy (confira o ID da conexão).", status, code);
  if (status === 429) return new OpenFinanceError("A Pluggy pediu para esperar (limite de consultas). Tente mais tarde.", status, code);
  const msg = typeof b.message === "string" ? b.message.replace(/[\r\n]+/g, " ").slice(0, 160) : "";
  return new OpenFinanceError(`Erro da Pluggy (HTTP ${status})${msg ? `: ${msg}` : ""}.`, status, code);
}

export class PluggyClient implements OpenFinanceClient {
  readonly simulated = false;
  private apiKey: string | null = null;
  private apiKeyAt = 0;
  private readonly base: string;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    base = env().PLUGGY_API_URL,
  ) {
    this.base = base.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit = {}, auth = true, retried = false): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Accept: "application/json", ...(auth ? { "X-API-KEY": await this.key() } : {}), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new OpenFinanceError(`Não consegui falar com a Pluggy (${(err as Error).name === "TimeoutError" ? "tempo esgotado" : "sem conexão"}).`);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      // Chave expirada: gera outra e tenta uma vez.
      if (res.status === 401 && auth && !retried) {
        this.apiKey = null;
        return this.request(path, init, auth, true);
      }
      throw apiError(res.status, body);
    }
    return body;
  }

  private async key(): Promise<string> {
    // A chave da Pluggy vale 2 horas; renova antes.
    if (this.apiKey && Date.now() - this.apiKeyAt < 100 * 60_000) return this.apiKey;
    const body = (await this.request("auth", { method: "POST", body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret, nonExpiring: false }) }, false)) as { apiKey?: string } | null;
    if (!body?.apiKey) throw new OpenFinanceError("A Pluggy não devolveu a chave de acesso.");
    this.apiKey = body.apiKey;
    this.apiKeyAt = Date.now();
    return this.apiKey;
  }

  async verify(): Promise<void> {
    this.apiKey = null;
    await this.key();
  }

  async getItem(itemId: string): Promise<OFItem> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(itemId)) throw new OpenFinanceError("ID da conexão inválido.");
    const it = (await this.request(`items/${encodeURIComponent(itemId)}`)) as Record<string, unknown>;
    const connector = (it.connector ?? {}) as { name?: unknown };
    const error = (it.error ?? null) as { message?: unknown } | null;
    return {
      id: String(it.id ?? itemId),
      status: typeof it.status === "string" ? it.status : "UNKNOWN",
      institutionName: typeof connector.name === "string" ? connector.name : null,
      lastUpdatedAt: typeof it.lastUpdatedAt === "string" ? it.lastUpdatedAt : null,
      errorMessage: error && typeof error.message === "string" ? error.message.slice(0, 200) : null,
    };
  }

  async listAccounts(itemId: string): Promise<OFAccount[]> {
    const body = (await this.request(`accounts?itemId=${encodeURIComponent(itemId)}`)) as { results?: Array<Record<string, unknown>> } | null;
    return (body?.results ?? []).map((a) => ({
      id: String(a.id),
      type: a.type === "CREDIT" ? "CREDIT" : "BANK",
      subtype: typeof a.subtype === "string" ? a.subtype : null,
      name: String(a.marketingName ?? a.name ?? "Conta").slice(0, 120),
      numberLast4: last4(a.number),
      balanceCents: toCents(a.balance),
      currency: typeof a.currencyCode === "string" ? a.currencyCode : "BRL",
    }));
  }

  async listTransactions(accountId: string, from: string, to: string): Promise<OFTransaction[]> {
    const out: OFTransaction[] = [];
    let after: string | null = null;
    for (let page = 0; page < 60; page++) {
      const qs = new URLSearchParams({ accountId, dateFrom: from, dateTo: to });
      if (after) qs.set("after", after);
      const body = (await this.request(`v2/transactions?${qs.toString()}`)) as { results?: Array<Record<string, unknown>>; next?: string | null } | null;
      for (const t of body?.results ?? []) {
        const amount = typeof t.amountInAccountCurrency === "number" ? t.amountInAccountCurrency : t.amount;
        const cents = toCents(amount);
        if (cents === null || cents === 0) continue;
        const cc = (t.creditCardMetadata ?? null) as { installmentNumber?: unknown; totalInstallments?: unknown } | null;
        const number = Number(cc?.installmentNumber);
        const total = Number(cc?.totalInstallments);
        const merchant = (t.merchant ?? null) as { name?: unknown; businessName?: unknown } | null;
        out.push({
          id: String(t.id),
          date: String(t.date),
          description: String(t.description ?? t.descriptionRaw ?? "").trim().slice(0, 200) || "Lançamento do banco",
          amountCents: Math.abs(cents),
          // O tipo informado pelo banco decide o sentido (no cartão, DEBIT = compra).
          direction: t.type === "CREDIT" ? "IN" : "OUT",
          status: t.status === "PENDING" ? "PENDING" : "POSTED",
          currency: typeof t.currencyCode === "string" ? t.currencyCode : "BRL",
          installment: number >= 1 && total >= 2 && number <= total ? { number, total } : null,
          merchantName: merchant && typeof merchant.name === "string" ? merchant.name.slice(0, 120) : null,
        });
        if (out.length >= MAX_TRANSACTIONS_PER_SYNC) return out;
      }
      const next: string | null = body?.next ?? null;
      after = next ? new URL(next, this.base).searchParams.get("after") : null;
      if (!after) break;
    }
    return out;
  }
}

// -----------------------------------------------------------------------------
// Simulador (desenvolvimento): dados de exemplo, claramente identificados. Nunca é um banco real.
// -----------------------------------------------------------------------------

export const SIMULATED_ITEM_ID = "simulado-0000-banco";

function hashInt(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h);
}

export class SimulatedOpenFinanceClient implements OpenFinanceClient {
  readonly simulated = true;

  async verify(): Promise<void> {}

  async getItem(itemId: string): Promise<OFItem> {
    if (!itemId.startsWith("simulado")) throw new OpenFinanceError("No simulador, use um ID que comece com \"simulado\".", 404);
    return { id: itemId, status: "UPDATED", institutionName: "Banco Simulado (exemplo)", lastUpdatedAt: new Date().toISOString(), errorMessage: null };
  }

  async listAccounts(itemId: string): Promise<OFAccount[]> {
    return [
      { id: `${itemId}-conta`, type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Conta corrente simulada", numberLast4: "0001", balanceCents: 250_000, currency: "BRL" },
      { id: `${itemId}-cartao`, type: "CREDIT", subtype: "CREDIT_CARD", name: "Cartão simulado", numberLast4: "4242", balanceCents: 84_590, currency: "BRL" },
    ];
  }

  /** Lançamentos de exemplo estáveis por dia (o mesmo id sempre volta igual: testa o anti-duplicação). */
  async listTransactions(accountId: string, from: string, to: string): Promise<OFTransaction[]> {
    const card = accountId.endsWith("-cartao");
    const names = card ? ["Supermercado Exemplo", "Streaming Exemplo", "Farmácia Exemplo", "Restaurante Exemplo"] : ["Pix recebido Exemplo", "Conta de luz Exemplo", "Padaria Exemplo", "Transferência Exemplo"];
    const out: OFTransaction[] = [];
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) {
      const day = d.toISOString().slice(0, 10);
      const h = hashInt(`${accountId}|${day}`);
      if (h % 3 !== 0) continue;
      const name = names[h % names.length]!;
      out.push({
        id: `sim-${hashInt(accountId).toString(36)}-${day}`,
        date: `${day}T15:00:00.000Z`,
        description: `${name} (simulado)`,
        amountCents: 1_000 + (h % 20_000),
        direction: !card && name.startsWith("Pix recebido") ? "IN" : "OUT",
        status: "POSTED",
        currency: "BRL",
        installment: null,
        merchantName: null,
      });
    }
    return out;
  }
}

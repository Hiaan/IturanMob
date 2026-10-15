import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

export const PASSWORD = "SenhaForte#2026";

export function uniqueEmail(prefix = "e2e") {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
}

/** Requisições de API fora do navegador: em produção, a proteção CSRF exige Origin ou X-Requested-With. */
const API_HEADERS = { "X-Requested-With": "fetch" };

/** Cria uma família pela API (mais rápido); o cookie de sessão fica no contexto do navegador. */
export async function registerViaApi(request: APIRequestContext, opts: { householdName?: string; name?: string; email?: string } = {}) {
  const email = opts.email ?? uniqueEmail();
  const res = await request.post("/api/auth/register", {
    headers: API_HEADERS,
    data: { householdName: opts.householdName ?? "Família E2E", name: opts.name ?? "Pessoa E2E", email, password: PASSWORD, relation: "Titular" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return { email };
}

export async function apiPost<T = unknown>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data, headers: API_HEADERS });
  expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { data: T }).data;
}

export async function createAccount(request: APIRequestContext, name = "Conta Corrente", initialBalanceCents = 100_000) {
  return apiPost<{ id: string }>(request, "/api/v1/accounts", { name, institution: "Banco E2E", type: "CHECKING", initialBalanceCents });
}

/** Abre "Novo lançamento" → "Linguagem natural", interpreta e confirma. */
export async function addByNaturalLanguage(page: Page, text: string) {
  await page.getByRole("button", { name: "Novo lançamento" }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Novo lançamento" });
  await dialog.getByRole("tab", { name: /Linguagem natural/ }).click();
  await dialog.getByRole("textbox").fill(text);
  await dialog.getByRole("button", { name: /Interpretar/ }).click();
  await expect(dialog.getByText("Pré-visualização")).toBeVisible();
  await dialog.getByRole("button", { name: /^Confirmar/ }).click();
  await expect(dialog).toBeHidden();
}

export async function apiPatch<T = unknown>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.patch(url, { data, headers: API_HEADERS });
  expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { data: T }).data;
}

export async function apiGet<T = unknown>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url);
  expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { data: T }).data;
}

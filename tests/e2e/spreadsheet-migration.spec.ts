import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { apiGet, createAccount, registerViaApi } from "./helpers";

/**
 * Assistente "Migrar de planilha": envia a lista simples, confere abas e colunas, aplica as
 * sugestões do De → Para, escolhe a conta padrão, gera a prévia, importa e desfaz.
 * Sem worker, as etapas em segundo plano rodam no próprio servidor (a tela acompanha o progresso).
 */
test("migrar de planilha: do arquivo ao desfazer", async ({ page }) => {
  // Fluxo longo (6 etapas; em desenvolvimento cada rota compila no primeiro acesso).
  test.setTimeout(300_000);
  await registerViaApi(page.request, { householdName: "Família Migração E2E" });
  const account = await createAccount(page.request, "Conta Corrente", 100_000);

  await page.goto("/importacao");
  await page.getByRole("link", { name: /Migrar de planilha|Começar migração/ }).first().click();
  // Em desenvolvimento a página é compilada no primeiro acesso.
  await expect(page).toHaveURL(/\/importacao\/migrar/, { timeout: 60_000 });

  await page.getByLabel("Planilha para migrar").setInputFiles({
    name: "lista-simples.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: readFileSync("tests/fixtures/migration/lista-simples.xlsx"),
  });
  await page.getByRole("button", { name: "Enviar e interpretar" }).click();

  // Abas → colunas → correspondências.
  await expect(page.getByRole("heading", { name: "Abas da planilha" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Extrato").first()).toBeVisible();
  await page.getByRole("button", { name: /Continuar para colunas/ }).click();
  await page.getByRole("button", { name: /Continuar para correspondências/ }).click();
  await page.getByRole("button", { name: /Aplicar todas as sugestões/ }).click();
  await expect(page.getByRole("button", { name: /Aplicar todas as sugestões/ })).toBeHidden();

  // Conta padrão (a planilha não tem coluna de conta).
  await page.locator("#mig-default-account").click();
  await page.getByRole("option", { name: "Conta Corrente" }).click();
  await expect(page.locator("#mig-default-account")).toContainText("Conta Corrente");

  await page.getByRole("button", { name: "Gerar prévia" }).click();
  await expect(page.getByText("Resumo da migração")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Importar tudo" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Importar tudo" }).click();
  await expect(page.getByText("O que foi gravado")).toBeVisible({ timeout: 120_000 });

  const txs = await apiGet<{ items: Array<{ source: string; account: { id: string } | null }> }>(page.request, "/api/v1/transactions?pageSize=100");
  expect(txs.items).toHaveLength(10);
  expect(txs.items.every((t) => t.source === "IMPORT" && t.account?.id === account.id)).toBe(true);
  // A conta já existia com o saldo de hoje: o histórico de 2025 entra sem mudar esse saldo.
  const after = await apiGet<Array<{ id: string; balanceCents: number }>>(page.request, "/api/v1/accounts");
  expect(after.find((a) => a.id === account.id)!.balanceCents).toBe(100_000);

  await page.getByRole("button", { name: "Desfazer migração" }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Desfazer migração" }).click();
  await expect(page.getByText(/desfeita/i).first()).toBeVisible({ timeout: 30_000 });
  const undone = await apiGet<Array<{ id: string; balanceCents: number; initialBalanceCents: number }>>(page.request, "/api/v1/accounts");
  expect(undone.find((a) => a.id === account.id)).toMatchObject({ balanceCents: 100_000, initialBalanceCents: 100_000 });
  expect((await apiGet<{ items: unknown[] }>(page.request, "/api/v1/transactions?pageSize=100")).items).toHaveLength(0);
});

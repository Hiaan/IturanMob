import { expect, test } from "@playwright/test";
import { createAccount, registerViaApi } from "./helpers";

/** Painel: período em destaque e o clique em Despesas/Receitas abre Transações no mesmo período. */
test("painel: o período escolhido vai junto ao abrir Despesas e Receitas", async ({ page }) => {
  await registerViaApi(page.request);
  await createAccount(page.request);
  await page.goto("/");

  const period = page.getByRole("combobox", { name: "Período" });
  await expect(period).toContainText("Este mês");
  await period.click();
  await page.getByRole("option", { name: "Últimos 7 dias" }).click();
  await expect(period).toContainText("Últimos 7 dias");

  await page.getByRole("link", { name: /Despesas do período/ }).click();
  // A tela lê o link (período e tipo) e depois limpa o endereço: confere o que ficou aplicado.
  await expect(page.getByRole("heading", { name: "Transações" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remover filtro Despesa" })).toBeVisible();
  await expect(page.getByText("últimos 7 dias", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("combobox").filter({ hasText: "Últimos 7 dias" }).first()).toBeVisible();

  // De volta ao painel, em "Este mês": Receitas abre em "Este mês".
  await page.goto("/");
  await page.getByRole("combobox", { name: "Período" }).click();
  await page.getByRole("option", { name: "Este mês" }).click();
  await page.getByRole("link", { name: /Receitas do período/ }).click();
  await expect(page.getByRole("heading", { name: "Transações" })).toBeVisible();
  await expect(page.getByRole("combobox").filter({ hasText: "Este mês" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Remover filtro Receita" })).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { apiPost, createAccount, registerViaApi } from "./helpers";

/** Transações (computador): coluna "Data" própria e ordenação pelo título da coluna. */
test("transações: coluna Data e ordenar por data/valor clicando no título", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a tabela com colunas só aparece no computador");
  await registerViaApi(page.request);
  const acc = await createAccount(page.request);
  const iso = (daysAgo: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };
  const br = (isoDate: string) => isoDate.split("-").reverse().join("/");
  await apiPost(page.request, "/api/v1/transactions", { type: "EXPENSE", amountCents: 4_590, description: "Padaria", date: iso(0), accountId: acc.id });
  await apiPost(page.request, "/api/v1/transactions", { type: "EXPENSE", amountCents: 75_000, description: "Aluguel", date: iso(1), accountId: acc.id });

  await page.goto("/transacoes?preset=last7");
  const table = page.getByRole("table");
  const rows = table.locator("tbody tr").filter({ hasText: /Padaria|Aluguel/ });
  await expect(rows).toHaveCount(2);
  // Cada linha tem a data na sua própria coluna (a primeira depois da seleção).
  await expect(rows.filter({ hasText: "Padaria" }).getByRole("cell", { name: br(iso(0)), exact: true })).toBeVisible();

  await table.getByRole("button", { name: "Valor" }).click();
  await expect(table.locator("th[aria-sort=descending]")).toHaveText(/Valor/);
  await expect(rows.first()).toContainText("Aluguel");
  // Mesmo ordenando por valor, a data continua na coluna.
  await expect(rows.first().getByRole("cell", { name: br(iso(1)), exact: true })).toBeVisible();

  await table.getByRole("button", { name: "Data" }).click();
  await expect(table.locator("th[aria-sort=descending]")).toHaveText(/Data/);
  await expect(rows.first()).toContainText("Padaria");
  await table.getByRole("button", { name: "Data" }).click();
  await expect(table.locator("th[aria-sort=ascending]")).toHaveText(/Data/);
  await expect(rows.first()).toContainText("Aluguel");
});

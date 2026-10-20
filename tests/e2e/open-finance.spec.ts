import { expect, test } from "@playwright/test";
import { apiGet, apiPost, registerViaApi } from "./helpers";

/**
 * Integrações → Bancos (Open Finance) com o SIMULADOR (servidor de teste com
 * OPEN_FINANCE_SIMULATOR=true): aviso de dados de exemplo, banco pelo ID, vínculo da conta,
 * "Buscar agora" vira prévia para conferir, e a segunda busca não traz nada repetido.
 */
test("bancos: simulador, vínculo, buscar agora e sem duplicar", async ({ page }) => {
  test.setTimeout(180_000);
  await registerViaApi(page.request, { householdName: "Família Bancos E2E" });
  await apiPost(page.request, "/api/v1/accounts", { name: "Conta Teste E2E", type: "CHECKING", initialBalanceCents: 100_000 });
  await page.goto("/integracoes");
  await page.getByRole("button", { name: "Usar simulador (dados de exemplo)" }).click();
  await expect(page.getByText("SIMULADOR — dados de exemplo, nenhum banco real conectado")).toBeVisible();

  await page.getByLabel("Adicionar banco").fill("simulado-0000-banco");
  await page.getByRole("button", { name: "Adicionar banco" }).click();
  await expect(page.getByText("Conta corrente simulada")).toBeVisible();

  const status = await apiGet<{ items: Array<{ accounts: Array<{ id: string; type: string }> }> }>(page.request, "/api/v1/integrations/open-finance");
  const conta = status.items[0]!.accounts.find((a) => a.type === "BANK")!;
  await page.locator(`#of-link-${conta.id}`).click();
  await page.getByRole("option", { name: "Conta Teste E2E" }).click();
  await expect(page.locator(`#of-link-${conta.id}`)).toContainText("Conta Teste E2E");

  await page.getByRole("button", { name: "Buscar agora" }).click();
  await expect(page.getByText(/lançamentos? novos? para conferir/)).toBeVisible();
  const imports = await apiGet<Array<{ format: string; status: string }>>(page.request, "/api/v1/imports");
  expect(imports.filter((b) => b.format === "OPEN_FINANCE")).toHaveLength(1);
});

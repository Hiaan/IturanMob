import { expect, test } from "@playwright/test";
import { apiGet, registerViaApi } from "./helpers";

/**
 * Contas a pagar → "Adicionar boleto": cola a linha digitável, confere valor e vencimento lidos do
 * código, cadastra e copia o código. O mesmo boleto não pode ser cadastrado de novo.
 */

const LINE = "34191.79001 10104.351001 47910.201509 3 16310000023050"; // Itaú, R$ 230,50, vence 15/11/2026

test("boleto: colar o código, conferir, cadastrar e não duplicar", async ({ page }) => {
  test.setTimeout(180_000);
  await registerViaApi(page.request, { householdName: "Família Boleto E2E" });
  await page.goto("/contas-a-pagar");
  await page.getByRole("button", { name: "Adicionar boleto" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Código do boleto (linha digitável)").fill(LINE);
  await expect(dialog.getByText("R$ 230,50").first()).toBeVisible();
  await expect(dialog.getByText("15/11/2026").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Cadastrar boleto" }).click();
  await expect(page.getByText("Boleto cadastrado nas contas a pagar")).toBeVisible();

  const bills = await apiGet<{ items: Array<{ description: string; amountCents: number; dueDate: string; boletoLine: string | null }> }>(page.request, "/api/v1/bills?month=2026-11");
  expect(bills.items.filter((b) => b.boletoLine)).toEqual([expect.objectContaining({ amountCents: 23_050, dueDate: "2026-11-15", boletoLine: LINE.replace(/\D/g, "") })]);

  await page.getByRole("button", { name: "Adicionar boleto" }).first().click();
  await page.getByRole("dialog").getByLabel("Código do boleto (linha digitável)").fill(LINE);
  await expect(page.getByRole("dialog").getByText("Este boleto já está nas contas a pagar")).toBeVisible();
});

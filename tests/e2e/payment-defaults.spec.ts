import { expect, test } from "@playwright/test";
import { createAccount, registerViaApi } from "./helpers";

/** Conta padrão de pagamento: escolhida em Configurações, já vem marcada no lançamento novo. */
test("conta padrão de pagamento: salvar em Preferências e vir preenchida no lançamento", async ({ page }) => {
  await registerViaApi(page.request);
  await createAccount(page.request, "Nubank");
  await createAccount(page.request, "C6 Bank");

  await page.goto("/configuracoes?tab=preferencias");
  const card = page.locator("[data-slot=card]").filter({ hasText: "Minha conta padrão de pagamento" });
  await card.getByLabel("Conta").click();
  await page.getByRole("option", { name: "C6 Bank" }).click();
  await card.getByLabel("Forma de pagamento").click();
  await page.getByRole("option", { name: "Pix" }).click();
  await card.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Conta padrão salva.")).toBeVisible();

  await page.goto("/transacoes");
  await page.getByRole("button", { name: "Novo lançamento" }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Novo lançamento" });
  await dialog.getByRole("tab", { name: /Formulário/ }).click();
  await expect(dialog.locator("#account")).toContainText("C6 Bank");
  await expect(dialog.locator("#method")).toContainText("Pix");
});

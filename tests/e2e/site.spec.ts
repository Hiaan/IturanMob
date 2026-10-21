import { expect, test } from "@playwright/test";

/** Site de vendas: visitante sem sessão em "/" vê o site; "Entrar" leva ao login; sem rolagem lateral no celular. */
test("site de vendas para quem não está logado", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mande uma mensagem.");
  await expect(page.getByRole("heading", { name: "Organizar o dinheiro em 3 passos" })).toBeVisible();
  await page.getByText("O Finance AI lê as minhas outras conversas?").click();
  await expect(page.getByText("Ele só processa o grupo que vocês autorizarem")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/login/);
});

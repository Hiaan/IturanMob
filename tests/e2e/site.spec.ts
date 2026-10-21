import { expect, test } from "@playwright/test";

/** Site de vendas: visitante sem sessão em "/" vê o site; "Entrar" leva ao login; sem rolagem lateral no celular. */
test("site de vendas para quem não está logado", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Sua vida financeira organizada");
  await expect(page.getByRole("heading", { name: "Três passos. Nenhuma planilha." })).toBeVisible();
  // Pacotes: anual por padrão (2 meses grátis); mensal mostra o preço cheio.
  const familia = page.getByRole("article", { name: "Plano Família", exact: true });
  await expect(familia).toContainText("R$ 299,00 por ano");
  await page.getByRole("radio", { name: "Mensal" }).click();
  await expect(familia).toContainText("29,90");
  await expect(page.getByRole("article", { name: "Plano Essencial" })).toContainText("19,90");
  await expect(page.getByRole("article", { name: "Plano Família + Empresa" })).toContainText("49,90");
  await expect(familia.getByRole("button", { name: "Quero o Família" })).toBeDisabled();
  await page.getByText("O Finance AI lê as minhas outras conversas?").click();
  await expect(page.getByText("Ele só processa o grupo que vocês autorizarem")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/login/);
});

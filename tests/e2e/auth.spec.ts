import { expect, test } from "@playwright/test";
import { PASSWORD, uniqueEmail } from "./helpers";

test.describe("autenticação", () => {
  test("cadastro, saída e novo login", async ({ page }) => {
    const email = uniqueEmail("cadastro");
    await page.goto("/cadastro");
    await page.getByLabel("Nome da família").fill("Família Cadastro E2E");
    await page.getByLabel("Seu nome").fill("Ana E2E");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Criar família" }).click();

    await page.waitForURL((u) => u.pathname === "/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Menu do usuário" }).click();
    await page.getByRole("menuitem", { name: "Sair" }).click();
    await page.waitForURL(/\/login/);

    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL((u) => u.pathname === "/");
  });

  test("senha errada mostra erro e não cria sessão", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail").fill("ninguem@example.com");
    await page.getByLabel("Senha", { exact: true }).fill("SenhaErrada#123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // A senha nunca vai para a URL (formulário via POST mesmo antes da hidratação).
    expect(page.url()).not.toContain("SenhaErrada");
  });

  test("páginas protegidas exigem sessão", async ({ page }) => {
    await page.goto("/transacoes");
    await expect(page).toHaveURL(/\/login/);
    const res = await page.request.get("/api/v1/me");
    expect(res.status()).toBe(401);
  });
});

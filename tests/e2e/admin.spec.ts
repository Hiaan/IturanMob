import { expect, test } from "@playwright/test";
import { PASSWORD, registerViaApi } from "./helpers";

/** Administração: só o administrador da instalação (INSTANCE_ADMIN_EMAILS) vê o menu e o painel. */
const ADMIN_EMAIL = "admin-e2e@example.com";

test("administração: painel do administrador e prévia de aviso; outras famílias não veem", async ({ page, browser }) => {
  // O banco de e2e é zerado a cada rodada; com servidor externo, o administrador pode já existir.
  const reg = await page.request.post("/api/auth/register", {
    headers: { "X-Requested-With": "fetch" },
    data: { householdName: "Família Admin", name: "Admin E2E", email: ADMIN_EMAIL, password: PASSWORD, relation: "Titular" },
  });
  if (reg.status() !== 201) {
    const login = await page.request.post("/api/auth/login", { headers: { "X-Requested-With": "fetch" }, data: { email: ADMIN_EMAIL, password: PASSWORD } });
    expect(login.ok(), await login.text()).toBeTruthy();
  }
  await page.goto("/");
  await page.getByRole("link", { name: "Administração" }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { name: "Administração" })).toBeVisible();
  await expect(page.getByText("Atualizações", { exact: true })).toBeVisible();
  await expect(page.getByText("Saúde do sistema", { exact: true })).toBeVisible();
  // Sem o script do servidor ligado: automático desligado e o botão explica por quê.
  await expect(page.getByText("desligada", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Atualizar agora" })).toBeDisabled();

  await page.getByLabel("Título (aparece no app)").fill("Novidades de teste");
  await page.getByLabel("Mensagem").fill("Mensagem de teste para as famílias.");
  await expect(page.getByRole("button", { name: "Enviar" })).toBeDisabled();
  await page.getByRole("button", { name: "Ver quem recebe" }).click();
  await expect(page.getByRole("status").filter({ hasText: /recebe/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar" })).toBeEnabled();

  // Outra família: sem menu e sem acesso ao painel.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await registerViaApi(p2.request);
  await p2.goto("/");
  await expect(p2.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(p2.getByRole("link", { name: "Administração" })).toHaveCount(0);
  expect((await p2.request.get("/api/v1/instance/status")).status()).toBe(403);
  await p2.goto("/administracao");
  await expect(p2.getByText("Só o administrador desta instalação acessa esta página.")).toBeVisible();
  await other.close();
});

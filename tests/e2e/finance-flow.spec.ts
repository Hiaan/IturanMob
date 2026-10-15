import { expect, test } from "@playwright/test";
import { addByNaturalLanguage, createAccount, registerViaApi } from "./helpers";

test.describe("fluxo financeiro no painel", () => {
  test.beforeEach(async ({ page }) => {
    await registerViaApi(page.request, { householdName: "Família Fluxo E2E" });
    await createAccount(page.request, "Conta Corrente", 100_000);
  });

  test("lançamento em linguagem natural com várias despesas atualiza o dashboard", async ({ page }) => {
    await page.goto("/");
    await addByNaturalLanguage(page, "hoje gastei 45,90 no mercado no pix e 30 de uber");

    const res = await page.request.get("/api/v1/transactions");
    const body = (await res.json()) as { data: { items: Array<{ amountCents: number; type: string; status: string }> } };
    const amounts = body.data.items.map((t) => t.amountCents).sort((a, b) => a - b);
    expect(amounts).toEqual([3000, 4590]);
    expect(body.data.items.every((t) => t.type === "EXPENSE" && t.status === "CONFIRMED")).toBeTruthy();

    // Dashboard (tempo real/invalidação): total de despesas do mês.
    await page.goto("/");
    await expect(page.getByText("R$ 75,90").first()).toBeVisible();
    // Saldo da conta: 1.000,00 − 75,90.
    const accounts = (await (await page.request.get("/api/v1/accounts")).json()) as { data: Array<{ name: string; balanceCents: number }> };
    expect(accounts.data.find((a) => a.name === "Conta Corrente")?.balanceCents).toBe(92_410);
  });

  test("mensagem sem valor não pode ser confirmada", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Novo lançamento" }).filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Novo lançamento" });
    await dialog.getByRole("tab", { name: /Linguagem natural/ }).click();
    await dialog.getByRole("textbox").fill("comprei pão na padaria");
    await dialog.getByRole("button", { name: /Interpretar/ }).click();
    await expect(dialog.getByText(/Falta informar: valor/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Confirmar/ })).toBeDisabled();
  });

  test("assistente responde com os dados da família", async ({ page }) => {
    await page.goto("/");
    await addByNaturalLanguage(page, "gastei 45,90 no mercado no pix");
    await page.goto("/assistente");
    await page.getByLabel("Pergunta para o assistente").fill("quanto gastamos com supermercado este mês?");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText(/45,90/).last()).toBeVisible();
  });

  test("dados de outra família não aparecem", async ({ page, browser }) => {
    await page.goto("/");
    await addByNaturalLanguage(page, "gastei 45,90 no mercado no pix");
    const mine = (await (await page.request.get("/api/v1/transactions")).json()) as { data: { items: Array<{ id: string }> } };
    const txId = mine.data.items[0]!.id;

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await registerViaApi(otherPage.request, { householdName: "Outra Família E2E" });
    const list = (await (await otherPage.request.get("/api/v1/transactions")).json()) as { data: { items: unknown[] } };
    expect(list.data.items).toHaveLength(0);
    const direct = await otherPage.request.get(`/api/v1/transactions/${txId}`);
    expect(direct.status()).toBe(404);
    const del = await otherPage.request.delete(`/api/v1/transactions/${txId}`, { headers: { "X-Requested-With": "fetch" } });
    expect(del.status()).toBe(404);
    await other.close();
  });
});

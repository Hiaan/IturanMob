import { expect, test } from "@playwright/test";
import { apiGet, apiPatch, apiPost, createAccount, registerViaApi } from "./helpers";

/**
 * Fluxo do canal principal com o SIMULADOR de WhatsApp (nenhuma conexão real): participante com
 * telefone, autorização e consentimento → grupo autorizado → mensagem → lançamento + resposta do bot.
 * Sem worker em execução, a própria API processa a mensagem simulada em linha.
 */
test("mensagem no grupo simulado vira lançamento e recebe resposta", async ({ page }) => {
  await registerViaApi(page.request, { householdName: "Família WhatsApp E2E" });
  await createAccount(page.request, "Conta Corrente", 50_000);
  const me = await apiGet<{ member: { id: string } }>(page.request, "/api/v1/me");
  await apiPatch(page.request, `/api/v1/members/${me.member.id}`, { whatsappPhone: "+5581999990001", whatsappAuthorized: true, whatsappConsent: true });
  await apiPatch(page.request, "/api/v1/integrations/whatsapp/settings", { provider: "SIMULATOR" });
  await apiPost(page.request, "/api/v1/integrations/whatsapp/groups/sync", {});
  const status = await apiGet<{ groups: Array<{ id: string; isAuthorized: boolean }> }>(page.request, "/api/v1/integrations/whatsapp");
  expect(status.groups.length).toBeGreaterThan(0);
  await apiPatch(page.request, `/api/v1/integrations/whatsapp/groups/${status.groups[0]!.id}`, { authorized: true });

  await page.goto("/integracoes/whatsapp?tab=simulador");
  await expect(page.getByText(/nenhuma mensagem é enviada a um WhatsApp real/i).first()).toBeVisible();
  await page.getByLabel("Mensagem simulada").fill("gastei 32,50 na farmácia no pix");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();

  // Resposta do bot na conversa simulada.
  await expect(page.getByLabel("Conversa simulada").getByText(/R\$ 32,50/).last()).toBeVisible({ timeout: 20_000 });

  const txs = await apiGet<{ items: Array<{ amountCents: number; source: string; status: string }> }>(page.request, "/api/v1/transactions");
  expect(txs.items).toHaveLength(1);
  expect(txs.items[0]).toMatchObject({ amountCents: 3250, source: "WHATSAPP_TEXT", status: "CONFIRMED" });
  // Uma única conta cadastrada: o PIX sai dela.
  const accounts = await apiGet<Array<{ balanceCents: number }>>(page.request, "/api/v1/accounts");
  expect(accounts[0]!.balanceCents).toBe(50_000 - 3250);
});

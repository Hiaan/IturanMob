import { expect, test } from "@playwright/test";
import { apiGet, registerViaApi } from "./helpers";

/**
 * Agenda: marcar um compromisso pela tela (com hora e lembrete), ver na lista, desmarcar com
 * confirmação; agenda simulada do Google (servidor de teste com GOOGLE_CALENDAR_SIMULATOR=true).
 */
test("agenda: marcar, ver, desmarcar e agenda simulada do Google", async ({ page }) => {
  test.setTimeout(180_000);
  await registerViaApi(page.request, { householdName: "Família Agenda E2E" });
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { name: "Agenda", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Marcar o primeiro compromisso" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Título").fill("Dentista E2E");
  const tomorrow = new Date(Date.now() + 86_400_000);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife" }).format(tomorrow);
  await dialog.getByLabel("Data").fill(iso);
  await dialog.getByLabel("Hora").fill("15:00");
  await dialog.getByLabel("Local").fill("Clínica");
  await dialog.getByRole("button", { name: "Marcar compromisso" }).click();
  await expect(page.getByText("Compromisso marcado")).toBeVisible();
  await expect(page.getByText("Dentista E2E").first()).toBeVisible();
  await expect(page.getByText("Aviso 1 h antes").first()).toBeVisible();

  const list = await apiGet<Array<{ title: string; time: string | null; date: string }>>(page.request, "/api/v1/agenda");
  expect(list).toEqual([expect.objectContaining({ title: "Dentista E2E", time: "15:00", date: iso })]);

  await page.getByRole("button", { name: "Desmarcar Dentista E2E" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Desmarcar" }).click();
  await expect(page.getByText("Compromisso desmarcado")).toBeVisible();
  expect(await apiGet(page.request, "/api/v1/agenda")).toEqual([]);

  // Google Agenda: o dono configura um app de exemplo e usa a agenda simulada.
  await page.getByLabel("Client ID").fill("123-e2e.apps.googleusercontent.com");
  await page.getByLabel("Client Secret").fill("segredo-de-exemplo-e2e");
  await page.getByRole("button", { name: "Salvar aplicativo" }).click();
  await page.getByRole("button", { name: "Usar agenda simulada (exemplo)" }).click();
  await expect(page.getByText("SIMULADO").first()).toBeVisible();
  await expect(page.getByText("Consulta (simulado)").first()).toBeVisible();
});

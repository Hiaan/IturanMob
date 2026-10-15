import { expect, test } from "@playwright/test";
import { addByNaturalLanguage, createAccount, registerViaApi } from "./helpers";

test("painel no celular: navegação inferior e novo lançamento", async ({ page }) => {
  await registerViaApi(page.request, { householdName: "Família Mobile E2E" });
  await createAccount(page.request);
  await page.goto("/");
  // Sem rolagem horizontal na largura do celular.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await addByNaturalLanguage(page, "gastei 12,50 na padaria no pix");
  await page.goto("/pendencias");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

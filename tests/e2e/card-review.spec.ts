import { expect, test } from "@playwright/test";
import { apiGet, apiPost, createAccount, registerViaApi } from "./helpers";

/**
 * Confirmar fatura: envia uma fatura de cartão (OFX), passa da revisão para "Confirmar fatura",
 * marca 2 compras como "Não importar" (uma delas parcelada), confere os totais, importa e verifica
 * que as duas ficaram fora dos lançamentos e da fatura. Também confere a lista em 375 px de largura.
 */

interface Line {
  fitId: string;
  date: string;
  amount: string;
  name: string;
  type?: string;
}

/** Mesmo formato de tests/integration/card-review.test.ts (compras positivas no arquivo). */
function cardOfx(lines: Line[]): string {
  const trns = lines
    .map((l) => `<STMTTRN><TRNTYPE>${l.type ?? "DEBIT"}</TRNTYPE><DTPOSTED>${l.date}</DTPOSTED><TRNAMT>${l.amount}</TRNAMT><FITID>${l.fitId}</FITID><MEMO>${l.name}</MEMO></STMTTRN>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><CCSTMTRS><CURDEF>BRL</CURDEF>
<CCACCTFROM><ACCTID>4321</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261231</DTEND>
${trns}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
}

const OFX = cardOfx([
  { fitId: "C1", date: "20261005", amount: "89.90", name: "RESTAURANTE SABOR" },
  { fitId: "C2", date: "20261006", amount: "600.00", name: "LOJA DO AMIGO" },
  { fitId: "C3", date: "20261007", amount: "300.00", name: "ELETRONICOS XYZ PARC 01/03" },
  { fitId: "C4", date: "20261008", amount: "45.00", name: "FARMACIA" },
  { fitId: "C5", date: "20261009", amount: "-500.00", name: "PAGAMENTO RECEBIDO", type: "CREDIT" },
  { fitId: "C6", date: "20261010", amount: "12.34", name: "IOF COMPRA INTERNACIONAL" },
]);

test("confirmar fatura: não importar 2 compras (uma parcelada), totais e importação", async ({ page }) => {
  // Em desenvolvimento cada rota compila no primeiro acesso.
  test.setTimeout(240_000);
  await registerViaApi(page.request, { householdName: "Família Fatura E2E" });
  const account = await createAccount(page.request, "Conta Corrente", 100_000);
  const card = await apiPost<{ id: string }>(page.request, "/api/v1/cards", { name: "Cartão E2E", issuer: "Banco E2E", closingDay: 3, dueDay: 10, limitCents: 1_000_000, paymentAccountId: account.id });

  // Envio: arquivo OFX com destino no cartão.
  await page.goto("/importacao");
  await page.getByLabel("Arquivos do extrato").setInputFiles({ name: "fatura-outubro.ofx", mimeType: "application/x-ofx", buffer: Buffer.from(OFX, "utf8") });
  await page.locator("#imp-destination").click();
  await page.getByRole("option", { name: "Cartão E2E" }).click();
  await page.getByRole("button", { name: "Enviar e pré-visualizar" }).click();
  await expect(page).toHaveURL(/batch=/, { timeout: 60_000 });

  // Revisão → Confirmar fatura (no cartão, a importação final fica nessa etapa).
  const steps = page.getByRole("list", { name: "Etapas da importação" });
  await expect(steps).toContainText("Confirmar fatura");
  await page.getByRole("button", { name: "Continuar: Confirmar fatura" }).click();
  await expect(page.getByRole("heading", { name: "Alguma dessas compras não é sua ou está errada?" })).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toContainText("Confirmar fatura");

  const totals = page.getByRole("region", { name: "Totais da conferência" });
  await expect(totals).toContainText("Fatura no arquivo R$ 1.047,24 · vai entrar R$ 1.047,24 · diferença R$ 0,00 (0 não importadas)");
  // O pagamento da fatura não é compra: fica fora da conferência.
  await expect(page.getByText("Pagamentos e créditos da fatura (R$ 500,00) não entram na conferência.")).toBeVisible();

  const list = page.getByRole("list", { name: "Compras para conferir" });
  const purchase = (text: string) => list.getByRole("listitem").filter({ hasText: text });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(purchase("ELETRONICOS XYZ PARC 01/03")).toContainText("Parcelada — a escolha vale para a compra inteira (3 parcelas, total R$ 900,00)");
  await expect(purchase("IOF COMPRA INTERNACIONAL")).toContainText("Internacional/IOF");
  await expect(purchase("LOJA DO AMIGO").getByRole("radio", { name: "Importar", exact: true })).toHaveAttribute("aria-checked", "true");

  // Filtro rápido só muda o que aparece.
  await page.getByRole("button", { name: /Só parceladas/ }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(5);

  await purchase("LOJA DO AMIGO").getByRole("radio", { name: "Não importar" }).click();
  await purchase("ELETRONICOS XYZ PARC 01/03").getByRole("radio", { name: "Não importar" }).click();
  await expect(purchase("LOJA DO AMIGO").getByRole("radio", { name: "Não importar" })).toHaveAttribute("aria-checked", "true");
  await expect(purchase("ELETRONICOS XYZ PARC 01/03").getByRole("radio", { name: "Não importar" })).toHaveAttribute("aria-checked", "true");
  await expect(totals).toContainText("Fatura no arquivo R$ 1.047,24 · vai entrar R$ 147,24 · diferença R$ 900,00 (2 não importadas)");

  // Celular (375 px): os cartões cabem na largura, sem rolagem horizontal, e o toque tem 44 px.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(list).toBeVisible();
  await expect(totals).toBeVisible();
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageOverflow).toBeLessThanOrEqual(1);
  const cards = await list.getByRole("listitem").evaluateAll((els) => els.map((el) => ({ overflow: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right })));
  expect(cards).toHaveLength(5);
  for (const c of cards) {
    expect(c.overflow).toBeLessThanOrEqual(1);
    expect(c.right).toBeLessThanOrEqual(376);
  }
  const toggle = await purchase("FARMACIA").getByRole("radio", { name: "Não importar" }).boundingBox();
  expect(toggle?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1366, height: 900 });

  // Importa (o botão espera as escolhas chegarem ao servidor).
  await totals.getByRole("button", { name: "Importar", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("2 compras com “Não importar”");
  await dialog.getByRole("button", { name: "Importar", exact: true }).click();
  // O título da conciliação (o toast tem o mesmo texto, mas não é título).
  await expect(page.getByRole("heading", { name: "Importação concluída" })).toBeVisible({ timeout: 60_000 });

  // As 2 compras não importadas ficam fora dos lançamentos e da fatura (inclusive as parcelas futuras).
  const txs = await apiGet<{ items: Array<{ description: string }> }>(page.request, "/api/v1/transactions?pageSize=100");
  expect(txs.items.map((t) => t.description).sort()).toEqual(["FARMACIA", "IOF COMPRA INTERNACIONAL", "RESTAURANTE SABOR"]);
  const statements = await apiGet<Array<{ totalCents: number }>>(page.request, `/api/v1/cards/${card.id}/statements`);
  expect(statements.reduce((sum, s) => sum + s.totalCents, 0)).toBe(14_724);
});

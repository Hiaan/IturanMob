import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { apiGet, apiPost, apiPut, registerViaApi } from "./helpers";

/**
 * Pop-ups no app: 4 notificações não lidas gravadas direto no banco → ao abrir o app aparecem só 3,
 * as mais importantes (conta vencida, fatura que vence hoje, meta de ganho) e o último oferece
 * "Ver todas". "Já paguei" abre o pagamento da conta. Com "Mostrar pop-ups no app" desligado, nada
 * aparece. Também confere /metas em 375 px (sem rolagem horizontal).
 */

/** Data local (America/Recife) deslocada em dias, AAAA-MM-DD. */
function localDate(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const TITLES = {
  overdue: "Conta vencida: Internet E2E",
  statement: "Fatura a vencer: Cartão E2E",
  goal: "Meta de ganho: 80%",
  weekly: "Resumo semanal E2E",
};

async function freshLoad(page: Page, url = "/") {
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
}

test("pop-ups no app: 3 mais importantes, Ver todas, Já paguei e preferência desligada", async ({ page }) => {
  // Em desenvolvimento cada rota compila no primeiro acesso.
  test.setTimeout(240_000);
  const { email } = await registerViaApi(page.request, { householdName: "Família Pop-ups E2E" });
  const dueDate = localDate(-2);
  const bill = await apiPost<{ id: string; status: string }>(page.request, "/api/v1/bills", { type: "EXPENSE", description: "Internet E2E", amountCents: 9_990, isEstimate: false, dueDate });
  expect(bill.status).toBe("OVERDUE");

  const prisma = new PrismaClient({ datasourceUrl: E2E_DATABASE_URL });
  try {
    const member = await prisma.householdMember.findFirstOrThrow({ where: { user: { email } }, select: { id: true, householdId: true } });
    const base = { householdId: member.householdId, recipientMemberId: member.id, channel: "IN_APP" as const, status: "SENT" as const, sentAt: new Date() };
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    await prisma.notification.createMany({
      data: [
        {
          ...base,
          type: "BILL_OVERDUE",
          title: TITLES.overdue,
          body: "Internet E2E venceu há 2 dias e não foi marcada como paga (R$ 99,90).",
          data: { scheduledPaymentId: bill.id, url: "/contas-a-pagar", stage: "OVERDUE", daysLate: 2, dueDate, amountCents: 9_990 },
          dedupeKey: `e2e-popups:overdue:${member.id}`,
          createdAt: ago(30),
        },
        {
          ...base,
          type: "STATEMENT_DUE",
          title: TITLES.statement,
          body: "A fatura do Cartão E2E vence hoje: R$ 450,00 em aberto.",
          data: { url: "/cartoes", stage: "TODAY" },
          dedupeKey: `e2e-popups:statement:${member.id}`,
          createdAt: ago(20),
        },
        {
          ...base,
          type: "INCOME_GOAL",
          title: TITLES.goal,
          body: "Meta de ganho de outubro: 80% — R$ 8.000,00 de R$ 10.000,00.",
          data: { url: "/metas" },
          dedupeKey: `e2e-popups:goal:${member.id}`,
          createdAt: ago(10),
        },
        // A mais recente, mas a menos importante: fica de fora dos 3 pop-ups.
        {
          ...base,
          type: "WEEKLY_REPORT",
          title: TITLES.weekly,
          body: "O resumo da semana está disponível.",
          data: { url: "/relatorios" },
          dedupeKey: `e2e-popups:weekly:${member.id}`,
          createdAt: ago(1),
        },
      ],
    });
  } finally {
    await prisma.$disconnect();
  }

  const popups = page.getByTestId("notification-popup");
  const popup = (title: string) => popups.filter({ hasText: title });

  // Primeira carga (navegador sem histórico): exatamente 3, os mais importantes, nessa ordem; "Ver todas" só no último.
  await page.goto("/");
  // Em desenvolvimento, as rotas de API compilam no primeiro acesso (preferência → não lidas).
  await expect(popups).toHaveCount(3, { timeout: 60_000 });
  await expect(popups).toContainText([TITLES.overdue, TITLES.statement, TITLES.goal]);
  await expect(popup(TITLES.weekly)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ver todas" })).toHaveCount(1);
  await expect(popup(TITLES.goal).getByRole("button", { name: "Ver todas" })).toHaveCount(1);
  await expect(popup(TITLES.overdue).getByRole("button", { name: "Já paguei" })).toHaveCount(1);
  await expect(popup(TITLES.overdue).getByRole("button", { name: "Pagar depois" })).toHaveCount(1);

  // Já mostrados neste navegador: recarregar só traz o que faltava (o resumo semanal).
  await page.reload();
  await expect(popups).toHaveCount(1);
  await expect(popups).toContainText(TITLES.weekly);

  // "Ver todas" abre o sininho com as 4.
  await freshLoad(page);
  await expect(popups).toHaveCount(3);
  await popups.first().hover(); // expande a pilha de avisos
  await popup(TITLES.goal).getByRole("button", { name: "Ver todas" }).click();
  const bell = page.getByRole("dialog", { name: "Notificações" });
  await expect(bell).toBeVisible();
  for (const title of Object.values(TITLES)) await expect(bell).toContainText(title);
  await expect(popups).toHaveCount(0);
  await page.keyboard.press("Escape");

  // "Já paguei": abre o pagamento da conta vencida e marca o aviso como lido.
  await freshLoad(page);
  await expect(popups).toHaveCount(3);
  await popups.first().hover();
  await popup(TITLES.overdue).getByRole("button", { name: "Já paguei" }).click();
  await expect(page).toHaveURL(/\/contas-a-pagar/, { timeout: 60_000 });
  const payDialog = page.getByRole("dialog", { name: "Registrar pagamento" });
  await expect(payDialog).toBeVisible({ timeout: 60_000 });
  await expect(payDialog).toContainText("Internet E2E");
  await payDialog.getByRole("button", { name: "Cancelar" }).click();
  await expect.poll(async () => (await apiGet<{ unreadCount: number }>(page.request, "/api/v1/notifications?unreadOnly=true")).unreadCount).toBe(3);

  // Preferência desligada: nenhum pop-up, mesmo com o histórico do navegador limpo.
  await apiPut(page.request, "/api/v1/notifications/popups", { inAppPopups: false });
  await page.evaluate(() => localStorage.clear());
  const prefLoaded = page.waitForResponse((r) => r.url().includes("/api/v1/notifications/popups") && r.request().method() === "GET");
  await page.goto("/");
  expect(((await (await prefLoaded).json()) as { data: { inAppPopups: boolean } }).data.inAppPopups).toBe(false);
  await page.waitForTimeout(2_000);
  await expect(popups).toHaveCount(0);

  // Configurações → Notificações: o interruptor reflete a preferência e os 4 tipos novos aparecem.
  await page.goto("/configuracoes?tab=notificacoes");
  await expect(page.getByRole("switch", { name: "Mostrar pop-ups no app" })).toHaveAttribute("aria-checked", "false");
  for (const label of ["Meta de ganho", "Metas de economia", "Conta vencida não paga", "Fatura perto de vencer"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  // Celular (375 px): /metas cabe na largura, com uma meta de ganho cadastrada.
  await apiPost(page.request, "/api/v1/income-goals", { scope: "BUSINESS", targetCents: 3_000_000 });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/metas");
  await expect(page.getByRole("heading", { name: "Metas de ganho" })).toBeVisible();
  await expect(page.getByText("Meta de ganho · Empresa")).toBeVisible();
  await expect(page.getByText("Faltam R$ 30.000,00", { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

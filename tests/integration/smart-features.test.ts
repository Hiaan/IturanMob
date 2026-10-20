import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

/**
 * Entrega A: boleto → conta a pagar (código colado, PDF e foto pelo WhatsApp; app), relatório e
 * planilha pedidos no WhatsApp (arquivo no recorte da família) e os avisos "vai faltar dinheiro" e
 * "assinatura esquecida / ficou mais cara". Só o provedor de visão é falso.
 */

const fake = vi.hoisted(() => ({ structured: vi.fn() }));

vi.mock("@/server/ai/providers/anthropic", () => ({
  AnthropicProvider: class FakeAnthropicProvider {
    readonly type = "ANTHROPIC";
    readonly supportsVision = true;
    constructor(
      readonly apiKey: string,
      readonly model: string,
    ) {}
    structured(req: unknown) {
      return fake.structured(req);
    }
    runTools() {
      throw new Error("não usado");
    }
  },
}));

import { prisma } from "@/server/db";
import { addDays, addMonths, todayISO } from "@/lib/dates";
import { formatDigitableLine } from "@/lib/boleto";
import { createAccount } from "@/server/modules/accounts/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { createBill, createBillFromBoleto, getBill, previewBoleto } from "@/server/modules/bills/service";
import { readBoletoFile } from "@/server/modules/bills/boleto-file";
import { handleReportCommand, parseReportCommand } from "@/server/ai/engine/report-commands";
import { readStoredFile } from "@/server/storage";
import { runCashShortfallAlerts } from "@/server/modules/alerts/cash";
import { acceptSubscriptionCandidate, listSubscriptionCandidates, runSubscriptionJobs, setSubscriptionCandidateStatus } from "@/server/modules/subscriptions/service";
import { createCard } from "@/server/modules/cards/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, enableExternalAI, initTestQueues, messageState, sendMessage, teardownTestQueues, TZ } from "./ai-pipeline-support";
import { makePdf } from "../helpers/pdf-fixtures";

const BANK = "34191790011010435100147910201509316310000023050"; // Itaú, R$ 230,50, vence 15/11/2026
/** Um dígito trocado: o dígito verificador não confere. */
const WRONG = BANK.slice(0, 40) + (BANK[40] === "9" ? "8" : "9") + BANK.slice(41);
const UTILITY = "836600000019899000360003000000000000001234567897"; // energia, R$ 189,90, sem vencimento

const at = (iso: string) => new Date(`${iso}T15:00:00Z`);

describe("Entrega A: boleto, relatório pelo WhatsApp e avisos espertos", () => {
  beforeAll(() => initTestQueues("smart"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
    fake.structured.mockReset();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  // ------------------------------------------------------------------ boleto: serviço e app

  it("boleto no app: confere o código, usa valor e vencimento do código e nunca duplica", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    await expect(previewBoleto(fam.ctx, WRONG)).rejects.toThrow(/não confere/);
    await expect(previewBoleto(fam.ctx, "1234")).rejects.toThrow(/47 ou 48 números/);
    const preview = await previewBoleto(fam.ctx, formatDigitableLine(BANK));
    expect(preview).toMatchObject({ label: "Boleto Itaú", existingBillId: null, boleto: { amountCents: 23_050, dueDate: "2026-11-15" } });

    // Valor e vencimento informados à mão não sobrepõem o que o código traz.
    const created = await createBillFromBoleto(fam.ctx, { line: BANK, description: "Escola", amountCents: 99_999, dueDate: "2026-12-01" });
    expect(created.duplicate).toBe(false);
    expect(created.bill).toMatchObject({ description: "Escola", amountCents: 23_050, dueDate: "2026-11-15", boletoLine: BANK, status: "PENDING" });
    const again = await createBillFromBoleto(fam.ctx, { line: formatDigitableLine(BANK) });
    expect(again).toMatchObject({ duplicate: true, bill: { id: created.bill.id } });
    expect(await prisma.scheduledPayment.count({ where: { householdId: fam.householdId } })).toBe(1);
    expect((await previewBoleto(fam.ctx, BANK)).existingBillId).toBe(created.bill.id);

    // Conta de consumo: o código não traz o vencimento → precisa ser informado.
    await expect(createBillFromBoleto(fam.ctx, { line: UTILITY })).rejects.toThrow(/não traz o vencimento/);
    const energy = await createBillFromBoleto(fam.ctx, { line: UTILITY, dueDate: "2026-10-28" });
    expect(energy.bill).toMatchObject({ description: "Conta: Energia elétrica e gás", amountCents: 18_990, dueDate: "2026-10-28" });

    // PDF de boleto enviado no app: lê o código e os dados impressos (sem gravar nada).
    const pdf = await makePdf([["Companhia Energética de Pernambuco", "Beneficiário: NEOENERGIA PERNAMBUCO", "Vencimento 28/10/2026", "Total a pagar R$ 189,90", formatDigitableLine(UTILITY)]]);
    const read = await readBoletoFile(fam.ctx, { fileName: "conta.pdf", mimeType: "application/pdf", content: pdf });
    expect(read).toMatchObject({ existingBillId: energy.bill.id, hints: { beneficiary: "NEOENERGIA PERNAMBUCO", dueDate: "2026-10-28", amountCents: 18_990 } });
    const paid = await makePdf([["Comprovante de pagamento", "Pagamento realizado com sucesso", formatDigitableLine(BANK)]]);
    await expect(readBoletoFile(fam.ctx, { fileName: "comprovante.pdf", mimeType: "application/pdf", content: paid })).rejects.toThrow(/já pago/);
    // Foto no app sem IA permitida: recusa com o motivo (nada é enviado para fora).
    await expect(readBoletoFile(fam.ctx, { fileName: "boleto.jpg", mimeType: "image/jpeg", content: Buffer.from("jpeg") })).rejects.toThrow(/Não consegui ler a foto/);
    expect(fake.structured).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ boleto: WhatsApp

  it("WhatsApp: código colado vira conta a pagar; repetido não duplica; 'paguei' marca como paga", async () => {
    const wa = await createWaFamily();
    const { itau } = await createBasicAccounts(wa.ctx);
    await prisma.account.updateMany({ where: { householdId: wa.householdId, id: { not: itau.id } }, data: { archivedAt: new Date() } });

    const first = await sendMessage(wa, { text: `boleto da escola ${formatDigitableLine(BANK)}` });
    const s1 = await messageState(wa, first.messageId);
    expect(s1.reply).toContain("Boleto cadastrado nas contas a pagar: *Escola* — R$ 230,50 — vence em 15/11/2026");
    expect(s1.reply).toContain(formatDigitableLine(BANK));
    const bill = await prisma.scheduledPayment.findFirstOrThrow({ where: { householdId: wa.householdId } });
    expect(bill).toMatchObject({ boletoLine: BANK, amountCents: 23_050, status: "PENDING" });
    // Nenhum lançamento: conta a pagar não é despesa até ser paga.
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId } })).toBe(0);

    const dup = await sendMessage(wa, { text: BANK });
    expect((await messageState(wa, dup.messageId)).reply).toContain("já está nas contas a pagar");
    expect(await prisma.scheduledPayment.count({ where: { householdId: wa.householdId } })).toBe(1);

    const paid = await sendMessage(wa, { text: `paguei ${BANK}` });
    expect((await messageState(wa, paid.messageId)).reply).toContain("Conta marcada como paga: *Escola* — R$ 230,50");
    const after = await getBill(wa.ctx, bill.id);
    expect(after.status).toBe("PAID");
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId, deletedAt: null } })).toBe(1);
  });

  it("WhatsApp: conta de consumo pergunta o vencimento; PDF de boleto usa a data impressa só se confirmada", async () => {
    const wa = await createWaFamily();
    const asked = await sendMessage(wa, { text: formatDigitableLine(UTILITY) });
    expect((await messageState(wa, asked.messageId)).reply).toContain("Qual é a data de vencimento?");
    expect(await prisma.scheduledPayment.count({ where: { householdId: wa.householdId } })).toBe(0);
    const bad = await sendMessage(wa, { text: "não sei" });
    expect((await messageState(wa, bad.messageId)).reply).toContain("o boleto não foi cadastrado");
    expect(await prisma.scheduledPayment.count({ where: { householdId: wa.householdId } })).toBe(0);

    const again = await sendMessage(wa, { text: UTILITY });
    expect((await messageState(wa, again.messageId)).reply).toContain("Qual é a data de vencimento?");
    const answer = await sendMessage(wa, { text: "28/10" });
    expect((await messageState(wa, answer.messageId)).reply).toContain("*Conta: Energia elétrica e gás* — R$ 189,90 — vence em 28/10/2026");

    // PDF de outro boleto de consumo (água): a data do documento é oferecida e confirmada com "sim".
    await prisma.scheduledPayment.deleteMany({ where: { householdId: wa.householdId } });
    const WATER = "828300000007755012345670890123456785901234567894";
    const pdf = await makePdf([["COMPESA - Companhia Pernambucana de Saneamento", "Beneficiário: COMPESA", "Vencimento: 05/11/2026", "Valor do documento 75,50", formatDigitableLine(WATER)]]);
    const doc = await sendMessage(wa, { type: "DOCUMENT", media: { bytes: pdf, mimeType: "application/pdf", fileName: "agua.pdf" } });
    const docReply = (await messageState(wa, doc.messageId)).reply;
    expect(docReply).toContain("Li o boleto *COMPESA* de R$ 75,50");
    expect(docReply).toContain("no documento aparece 05/11/2026");
    expect(await prisma.scheduledPayment.count({ where: { householdId: wa.householdId } })).toBe(0);
    const yes = await sendMessage(wa, { text: "sim" });
    expect((await messageState(wa, yes.messageId)).reply).toContain("*COMPESA* — R$ 75,50 — vence em 05/11/2026");
    expect(await prisma.importBatch.count({ where: { householdId: wa.householdId } })).toBe(0);
  });

  it("WhatsApp: foto de boleto só vale com os dígitos conferidos", async () => {
    const wa = await createWaFamily();
    await enableExternalAI(wa, ["RECEIPT_EXTRACTION"], { image: true });
    const vision = (line: string) => ({
      json: {
        legible: true,
        is_receipt: false,
        merchant: null,
        total: null,
        date: null,
        payment_method: null,
        card_last4: null,
        transaction_id: null,
        installments: null,
        items: [],
        confidence: 0.9,
        boleto: { digitable_line: line, beneficiary: "Escola Aprender LTDA CNPJ 12.345.678/0001-90", due_date: "2026-11-15", amount: 230.5 },
      },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    fake.structured.mockResolvedValueOnce(vision(WRONG));
    const wrong = await sendMessage(wa, { type: "IMAGE", media: { bytes: Buffer.from("jpeg-1"), mimeType: "image/jpeg" } });
    expect((await messageState(wa, wrong.messageId)).reply).toContain("não consegui ler o código com segurança");
    expect(await prisma.scheduledPayment.count({ where: { householdId: wa.householdId } })).toBe(0);
    expect(await prisma.pendingItem.count({ where: { householdId: wa.householdId, type: "UNREADABLE_RECEIPT" } })).toBe(1);

    fake.structured.mockResolvedValueOnce(vision(formatDigitableLine(BANK)));
    const ok = await sendMessage(wa, { type: "IMAGE", media: { bytes: Buffer.from("jpeg-2"), mimeType: "image/jpeg" } });
    expect((await messageState(wa, ok.messageId)).reply).toContain("Boleto cadastrado nas contas a pagar: *Escola Aprender LTDA* — R$ 230,50 — vence em 15/11/2026");
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId } })).toBe(0);
  });

  // ------------------------------------------------------------------ relatório pelo WhatsApp

  it("relatório e planilha pedidos no WhatsApp: arquivo no recorte da família (privados fora)", async () => {
    const wa = await createWaFamily();
    const { itau } = await createBasicAccounts(wa.ctx);
    const today = todayISO(TZ);
    await createTransaction(wa.ctx, { type: "EXPENSE", amountCents: 12_000, description: "Mercado da família", date: today, accountId: itau.id });
    const priv = await createAccount(wa.wifeCtx, { name: "Conta da Maria", visibility: "PRIVATE", initialBalanceCents: 50_000 });
    await createTransaction(wa.wifeCtx, { type: "EXPENSE", amountCents: 9_900, description: "Presente surpresa", date: today, accountId: priv.id });

    const sent = await sendMessage(wa, { text: "manda o relatório do mês" });
    const state = await messageState(wa, sent.messageId);
    expect(state.reply).toContain(`📎 relatorio-mensal-${today.slice(0, 7)}.pdf`);
    expect(state.reply).toContain("Contas e cartões privados não entram");
    // Nada foi lançado por engano.
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId } })).toBe(2);

    const cmd = parseReportCommand("me envia a planilha do mês", today)!;
    const out = await handleReportCommand(wa.ctx, cmd);
    const doc = out.documents![0]!;
    expect(doc.fileName).toBe(`relatorio-mensal-${today.slice(0, 7)}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readStoredFile(doc.storageKey)) as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? "")))));
    expect(cells.some((c) => c.includes("Mercado da família"))).toBe(true);
    expect(cells.some((c) => c.includes("Presente surpresa"))).toBe(false);
  });

  // ------------------------------------------------------------------ vai faltar dinheiro

  it("vai faltar dinheiro: avisa uma vez por semana, conta no cartão e contas privadas fora", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    const now = new Date();
    const today = todayISO(TZ, now);
    const conta = await createAccount(fam.ctx, { name: "Conta", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: addDays(today, -30) });
    const card = await createCard(fam.ctx, { name: "Cartão", issuer: "Banco", closingDay: 3, dueDay: 10, limitCents: 500_000, paymentAccountId: conta.id });
    const priv = await createAccount(fam.wifeCtx, { name: "Conta da Maria", visibility: "PRIVATE", initialBalanceCents: 0 });

    // Só cabe no saldo: sem aviso. Conta privada e conta lançada no cartão não contam no caixa.
    await createBill(fam.ctx, { description: "Aluguel", amountCents: 80_000, dueDate: addDays(today, 5), accountId: conta.id });
    await createBill(fam.wifeCtx, { description: "Conta secreta", amountCents: 500_000, dueDate: addDays(today, 6), accountId: priv.id });
    await createBill(fam.ctx, { description: "Streaming no cartão", amountCents: 900_000, dueDate: addDays(today, 7), creditCardId: card.id });
    expect(await runCashShortfallAlerts(now, { householdId: fam.householdId })).toMatchObject({ alerts: 0 });

    await createBill(fam.ctx, { description: "Escola", amountCents: 50_000, dueDate: addDays(today, 10), accountId: conta.id });
    expect(await runCashShortfallAlerts(now, { householdId: fam.householdId })).toMatchObject({ alerts: 1 });
    const notes = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "CASH_SHORTFALL", channel: "IN_APP" } });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.title).toBe("Vai faltar dinheiro");
    expect(notes[0]!.body).toContain("-R$ 300,00");
    expect(notes[0]!.body).toContain("Escola");
    expect(notes[0]!.body).not.toContain("secreta");
    // Mesma semana: não repete.
    expect(await runCashShortfallAlerts(now, { householdId: fam.householdId })).toMatchObject({ alerts: 0 });
    expect(await runCashShortfallAlerts(new Date(now.getTime() + 8 * 86_400_000), { householdId: fam.householdId })).toMatchObject({ alerts: 1 });
  });

  // ------------------------------------------------------------------ assinaturas

  it("assinatura esquecida: sugere, avisa aumento de preço, cadastra sem duplicar e respeita privacidade", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    const { card } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const charge = (monthsAgo: number, amountCents: number, description = "PG *NETFLIX.COM") =>
      createTransaction(fam.ctx, { type: "EXPENSE", amountCents, description, date: addMonths(addDays(today, -2), -monthsAgo), creditCardId: card.id });
    for (const m of [3, 2, 1]) await charge(m, 5_590);
    // Compras soltas no mercado (várias no mês) não são assinatura.
    for (const d of [3, 10, 17, 40, 47]) await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 20_000 + d, description: "Mercado Bom Preço", date: addDays(today, -d), creditCardId: card.id });

    const first = await runSubscriptionJobs(at(today), { householdId: fam.householdId });
    expect(first).toMatchObject({ found: 1, raises: 0 });
    const notes = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "SUBSCRIPTION_FOUND", channel: "IN_APP" } });
    expect(notes).toHaveLength(2); // casal
    expect(notes[0]!.body).toContain("PG *NETFLIX.COM cobrou R$ 55,90 em 3 meses seguidos");
    expect(await runSubscriptionJobs(at(today), { householdId: fam.householdId })).toMatchObject({ found: 0, raises: 0 });

    // Nova cobrança mais cara → aviso de aumento (uma vez).
    await charge(0, 5_990);
    expect(await runSubscriptionJobs(at(today), { householdId: fam.householdId })).toMatchObject({ found: 0, raises: 1 });
    expect(await runSubscriptionJobs(at(today), { householdId: fam.householdId })).toMatchObject({ raises: 0 });
    const [cand] = await listSubscriptionCandidates(fam.ctx);
    expect(cand).toMatchObject({ merchantName: "PG *NETFLIX.COM", amountCents: 5_990, previousAmountCents: 5_590, priceRaised: true, occurrences: 4 });

    // Cadastrar: vira gasto fixo sem lançamento automático; as cobranças passam a apontar para ele.
    const accepted = await acceptSubscriptionCandidate(fam.ctx, cand!.id, { description: "Netflix" });
    expect(accepted.linkedTransactions).toBe(4);
    const rec = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: accepted.recurring.id } });
    expect(rec).toMatchObject({ description: "Netflix", amountCents: 5_990, autoPost: false, creditCardId: card.id, frequency: "MONTHLY" });
    expect(await listSubscriptionCandidates(fam.ctx)).toEqual([]);
    await expect(acceptSubscriptionCandidate(fam.ctx, cand!.id)).rejects.toThrow(/já está nos gastos fixos/);
    const txCount = await prisma.transaction.count({ where: { householdId: fam.householdId } });
    expect(await runSubscriptionJobs(at(today), { householdId: fam.householdId })).toMatchObject({ found: 0, raises: 0 });
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(txCount);

    // Cartão privado da esposa: aviso só para ela e nunca no WhatsApp; o marido nem vê a sugestão.
    const privCard = await createCard(fam.wifeCtx, { name: "Cartão da Maria", issuer: "Banco", closingDay: 3, dueDay: 10, limitCents: 100_000, visibility: "PRIVATE" });
    for (const m of [3, 2, 1]) await createTransaction(fam.wifeCtx, { type: "EXPENSE", amountCents: 3_490, description: "Spotify", date: addMonths(addDays(today, -4), -m), creditCardId: privCard.id });
    expect(await runSubscriptionJobs(at(today), { householdId: fam.householdId })).toMatchObject({ found: 1 });
    const spotify = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "SUBSCRIPTION_FOUND", title: { contains: "Spotify" } } });
    expect(spotify.map((n) => [n.channel, n.recipientMemberId])).toEqual([["IN_APP", fam.wifeId]]);
    expect(await listSubscriptionCandidates(fam.ctx)).toEqual([]);
    const [wifeCand] = await listSubscriptionCandidates(fam.wifeCtx);
    expect(wifeCand).toMatchObject({ merchantName: "Spotify" });
    await setSubscriptionCandidateStatus(fam.wifeCtx, wifeCand!.id, "IGNORED");
    expect(await listSubscriptionCandidates(fam.wifeCtx)).toEqual([]);
    expect(await listSubscriptionCandidates(fam.wifeCtx, { status: "IGNORED" })).toHaveLength(1);
  });
});

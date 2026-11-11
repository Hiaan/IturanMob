import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Assistente conversacional do WhatsApp com o provedor de IA falso (scripts de chamadas de
 * ferramentas). O que importa aqui é o servidor: as ferramentas validam tudo — valor que não está
 * na mensagem não entra, correções vão no lançamento certo, apagar vai para a lixeira — e sem
 * consentimento ou acima do teto do mês o motor local responde.
 */

type ToolReq = {
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string }>;
  execute: (name: string, input: unknown) => Promise<unknown>;
};
const fake = vi.hoisted(() => ({ script: [] as Array<(req: ToolReq) => Promise<{ text: string; calls: string[] }>>, requests: [] as ToolReq[] }));

vi.mock("@/server/ai/providers/anthropic", () => ({
  AnthropicProvider: class FakeAnthropicProvider {
    readonly type = "ANTHROPIC";
    readonly supportsVision = true;
    constructor(
      readonly apiKey: string,
      readonly model: string,
    ) {}
    structured() {
      throw new Error("não usado");
    }
    async runTools(req: ToolReq) {
      fake.requests.push(req);
      const step = fake.script.shift();
      if (!step) throw new Error("roteiro vazio");
      const out = await step(req);
      return { text: out.text, toolCalls: out.calls.map((name) => ({ name, input: {}, ok: true })), usage: { inputTokens: 100, outputTokens: 50 } };
    }
  },
}));

import { prisma } from "@/server/db";
import { encryptString } from "@/server/crypto";
import { agentAvailable, toWhatsAppText } from "@/server/ai/agent/whatsapp-agent";
import { createWaFamily, enableExternalAI, initTestQueues, clearTestQueues, messageState, sendMessage, teardownTestQueues, type WaFamily } from "./ai-pipeline-support";
import { createBasicAccounts, resetDatabase } from "./helpers";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { createAccount, listAccounts } from "@/server/modules/accounts/service";
import { categoryId } from "./helpers";
import { createTransaction } from "@/server/modules/transactions/service";
import { ask } from "@/server/ai/assistant/service";
import { monthRange, todayISO } from "@/lib/dates";

/** Código L# do lançamento cuja linha contém o texto (como o modelo faria lendo o prompt). */
function refOf(system: string, text: string): string {
  const line = system.split("\n").find((l) => /^L\d+:/.test(l) && l.includes(text));
  if (!line) throw new Error(`lançamento "${text}" não está no prompt`);
  return line.split(":")[0]!;
}

async function aiFamily(): Promise<WaFamily> {
  const wa = await createWaFamily();
  await enableExternalAI(wa, ["PARSE_MESSAGE", "ASSISTANT"]);
  return wa;
}

describe("assistente conversacional do WhatsApp", () => {
  beforeAll(() => initTestQueues("agent"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
    fake.script = [];
    fake.requests = [];
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("a conversa da Rosineide e da Ariane: duas receitas de uma vez, correção solta e cancelamento", async () => {
    const wa = await aiFamily();
    // 1) Duas entradas na mesma mensagem.
    fake.script.push(async (req) => {
      const out = (await req.execute("registrar_lancamentos", {
        lancamentos: [
          { tipo: "receita", valor: 400, descricao: "Rosineide", data: null, categoria: null, conta: null, cartao: null, forma_pagamento: null, parcelas: null, pessoa: null, natureza: null },
          { tipo: "receita", valor: 739.75, descricao: "Ariane", data: null, categoria: null, conta: null, cartao: null, forma_pagamento: null, parcelas: null, pessoa: null, natureza: null },
        ],
      })) as { resultados: Array<{ status: string }> };
      expect(out.resultados.map((r) => r.status)).toEqual(["registrado", "registrado"]);
      return { text: "Anotei as duas entradas: **R$ 400,00** da Rosineide e **R$ 739,75** da Ariane.", calls: ["registrar_lancamentos"] };
    });
    const m1 = await sendMessage(wa, { text: "400 reais foi de rosineide e 739,75 de ariane" });
    expect((await messageState(wa, m1.messageId)).reply).toContain("Anotei as duas entradas: *R$ 400,00* da Rosineide e *R$ 739,75* da Ariane.");
    const txs = await prisma.transaction.findMany({ where: { householdId: wa.householdId }, orderBy: { amountCents: "asc" } });
    expect(txs.map((t) => [t.description, t.type, t.amountCents, t.status])).toEqual([
      ["Rosineide", "INCOME", 40_000, "CONFIRMED"],
      ["Ariane", "INCOME", 73_975, "CONFIRMED"],
    ]);
    // Nenhuma pergunta robótica pendente ficou aberta.
    expect(await prisma.clarification.count({ where: { householdId: wa.householdId, status: "OPEN" } })).toBe(0);

    // 2) Correção solta: o modelo acha a Ariane na lista do prompt; o histórico chega junto.
    fake.script.push(async (req) => {
      expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(req.messages[1]!.content).toContain("Anotei as duas entradas");
      await req.execute("corrigir_lancamento", { codigo: refOf(req.system, '"Ariane"'), tipo: "despesa", valor: null, descricao: null, data: null, categoria: null, conta: null, cartao: null, forma_pagamento: null, natureza: null });
      return { text: "Pronto, a da Ariane agora é despesa.", calls: ["corrigir_lancamento"] };
    });
    const m2 = await sendMessage(wa, { text: "a ariane na verdade foi um pagamento que eu fiz" });
    expect((await messageState(wa, m2.messageId)).reply).toContain("a da Ariane agora é despesa");
    expect((await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, description: "Ariane" } })).type).toBe("EXPENSE");

    // 3) Cancelar a da Rosineide: vai para a lixeira.
    fake.script.push(async (req) => {
      await req.execute("apagar_lancamento", { codigo: refOf(req.system, '"Rosineide"') });
      return { text: "Tirei a da Rosineide (dá para recuperar no app).", calls: ["apagar_lancamento"] };
    });
    await sendMessage(wa, { text: "cancela a da rosineide" });
    expect((await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, description: "Rosineide" } })).deletedAt).not.toBeNull();
  });

  it("nunca grava valor que não está na mensagem; categoria tem que existir; nome de pessoa não vira categoria", async () => {
    const wa = await aiFamily();
    fake.script.push(async (req) => {
      const out = (await req.execute("registrar_lancamentos", {
        lancamentos: [{ tipo: "despesa", valor: 999, descricao: "Mercado", data: null, categoria: "Alimentação", conta: null, cartao: null, forma_pagamento: null, parcelas: null, pessoa: null, natureza: null }],
      })) as { resultados: Array<{ erro?: string }> };
      expect(out.resultados[0]!.erro).toContain("não aparece nas mensagens");
      await expect(req.execute("criar_categoria", { nome: "João", tipo: "despesa" })).rejects.toThrow(/nome de uma pessoa/);
      const ok = (await req.execute("registrar_lancamentos", {
        lancamentos: [{ tipo: "despesa", valor: 87.5, descricao: "Mercado", data: null, categoria: "Alimentação", conta: null, cartao: null, forma_pagamento: null, parcelas: null, pessoa: null, natureza: null }],
      })) as { resultados: Array<{ categoria: string; codigo: string }> };
      expect(ok.resultados[0]!.categoria).toContain("Alimentação");
      await expect(req.execute("corrigir_lancamento", { codigo: ok.resultados[0]!.codigo, tipo: null, valor: null, descricao: null, data: null, categoria: "Inventada", conta: null, cartao: null, forma_pagamento: null, natureza: null })).rejects.toThrow(/não existe/);
      await expect(req.execute("corrigir_lancamento", { codigo: ok.resultados[0]!.codigo, tipo: null, valor: 120, descricao: null, data: null, categoria: null, conta: null, cartao: null, forma_pagamento: null, natureza: null })).rejects.toThrow(/não aparece/);
      return { text: "Anotei R$ 87,50 no mercado.", calls: ["registrar_lancamentos"] };
    });
    await sendMessage(wa, { text: "gastei 87,50 no mercado" });
    const txs = await prisma.transaction.findMany({ where: { householdId: wa.householdId } });
    expect(txs.map((t) => t.amountCents)).toEqual([8_750]);
    expect(await prisma.category.count({ where: { householdId: wa.householdId, name: "João" } })).toBe(0);
  });

  it("compra parcelada: '5x de 100' vira R$ 500 em 5 parcelas e o mês conta só a parcela", async () => {
    const wa = await aiFamily();
    await createBasicAccounts(wa.ctx);
    const today = todayISO("America/Recife");
    fake.script.push(async (req) => {
      const base = { tipo: "despesa", data: null, categoria: null, conta: null, cartao: null, forma_pagamento: "CREDIT_CARD", pessoa: null, natureza: null };
      const out = (await req.execute("registrar_lancamentos", {
        lancamentos: [
          { ...base, valor: 100, descricao: "Tênis", parcelas: 5, valor_da_parcela: true },
          { ...base, valor: 3000, descricao: "TV", parcelas: 10, valor_da_parcela: false },
        ],
      })) as { resultados: Array<{ valor: string; parcelas: string | null }> };
      expect(out.resultados.map((r) => [r.valor, r.parcelas])).toEqual([
        ["R$ 500,00", "5x de R$ 100,00 (no mês conta só a parcela)"],
        ["R$ 3.000,00", "10x de R$ 300,00 (no mês conta só a parcela)"],
      ]);
      return { text: "Anotei o tênis em 5x de R$ 100,00 e a TV em 10x de R$ 300,00.", calls: ["registrar_lancamentos"] };
    });
    await sendMessage(wa, { text: "comprei um tênis em 5x de 100 e uma tv de 3000 em 10x no cartão" });
    const txs = await prisma.transaction.findMany({ where: { householdId: wa.householdId }, orderBy: { amountCents: "asc" } });
    expect(txs.map((t) => [t.description, t.amountCents, t.installmentCount, Boolean(t.creditCardId)])).toEqual([
      ["Tênis", 50_000, 5, true],
      ["TV", 300_000, 10, true],
    ]);
    // Painel do mês (competência): só as parcelas, nunca o valor inteiro.
    const month = monthRange(today.slice(0, 7));
    const summary = await dashboardSummary(wa.ctx, { period: month, regime: "ACCRUAL", filters: { scope: "ALL" } });
    expect(summary.expenseCents).toBe(10_000 + 30_000);
  });

  it("saldo do caixa, conta nova, transferência e conta a pagar — tudo validado (valor dito, conta existente)", async () => {
    const wa = await aiFamily();
    const caixa1 = await createAccount(wa.ctx, { name: "Caixa 1", type: "WALLET", initialBalanceCents: 50_000 });
    fake.script.push(async (req) => {
      // Valor que ninguém disse: recusado.
      await expect(req.execute("ajustar_saldo", { conta: "Caixa 1", saldo: 999, data: null })).rejects.toThrow(/não aparece/);
      // Conta que não existe: pede para criar.
      await expect(req.execute("ajustar_saldo", { conta: "Caixa 2", saldo: 300, data: null })).rejects.toThrow(/Não achei a conta/);
      const s1 = (await req.execute("ajustar_saldo", { conta: "caixa 1", saldo: 1500, data: null })) as { saldo_anterior: string; saldo_agora: string; ajustado: boolean };
      expect(s1).toMatchObject({ saldo_anterior: "R$ 500,00", saldo_agora: "R$ 1.500,00", ajustado: true });
      const c2 = (await req.execute("criar_conta", { nome: "Caixa 2", tipo: "dinheiro", saldo_inicial: 300 })) as { criada: string };
      expect(c2.criada).toBe("Caixa 2");
      await expect(req.execute("criar_conta", { nome: "Caixa 2", tipo: "dinheiro", saldo_inicial: null })).rejects.toThrow(/Já existe/);
      // Apelido "caixa" serve para as duas: pergunta qual.
      await expect(req.execute("transferir", { de: "caixa", para: "Caixa 2", valor: 200, data: null, descricao: null })).rejects.toThrow(/mais de uma conta/);
      // Venda e transferência na mesma mensagem: os dois são gravados (cada um na sua posição).
      await req.execute("registrar_lancamentos", {
        lancamentos: [{ tipo: "receita", valor: 250, descricao: "Venda", data: null, categoria: null, conta: "Caixa 1", cartao: null, forma_pagamento: null, parcelas: null, pessoa: null, natureza: null }],
      });
      await req.execute("transferir", { de: "Caixa 1", para: "Caixa 2", valor: 200, data: null, descricao: null });
      await req.execute("cadastrar_conta_a_pagar", { descricao: "Conta de luz", valor: 180, vencimento: "2026-12-10", tipo: "pagar", conta: null });
      return { text: "Pronto: Caixa 1 com R$ 1.500,00, criei o Caixa 2 com R$ 300,00 e passei R$ 200,00 do Caixa 1 pro Caixa 2. Também cadastrei a conta de luz de R$ 180,00.", calls: ["ajustar_saldo", "criar_conta", "transferir", "cadastrar_conta_a_pagar"] };
    });
    const m = await sendMessage(wa, { text: "tenho 1.500 no caixa 1, cria o caixa 2 com 300, entrou 250 de venda no caixa 1 e passei 200 do caixa 1 pro caixa 2. a luz de 180 vence dia 10/12" });
    expect((await messageState(wa, m.messageId)).reply).toContain("criei o Caixa 2");
    const accounts = await listAccounts(wa.ctx);
    const byName = Object.fromEntries(accounts.map((a) => [a.name, a.balanceCents]));
    expect(byName["Caixa 1"]).toBe(150_000 + 25_000 - 20_000);
    expect(byName["Caixa 2"]).toBe(30_000 + 20_000);
    // O ajuste não é receita nem despesa; a transferência também não.
    const txs = await prisma.transaction.findMany({ where: { householdId: wa.householdId, deletedAt: null }, select: { type: true, amountCents: true } });
    expect(txs.map((t) => [t.type, t.amountCents]).sort()).toEqual([["ADJUSTMENT", 100_000], ["INCOME", 25_000], ["TRANSFER", 20_000]].sort());
    expect(await prisma.scheduledPayment.count({ where: { householdId: wa.householdId, description: "Conta de luz", amountCents: 18_000 } })).toBe(1);
    expect(caixa1.id).toBeTruthy();
  });

  it("'zera tudo': zera os saldos (positivos e negativos) sem a Isa calcular valores; sem pedido de zerar, recusa", async () => {
    const wa = await aiFamily();
    await createAccount(wa.ctx, { name: "Caixa - Thamires", type: "WALLET", initialBalanceCents: 10_000 });
    await createAccount(wa.ctx, { name: "Nubank - Thamires", type: "DIGITAL", initialBalanceCents: -102_775 });
    await createAccount(wa.ctx, { name: "Itaú", type: "CHECKING", initialBalanceCents: 0 });
    fake.script.push(async (req) => {
      await expect(req.execute("zerar_saldos", { contas: null })).rejects.toThrow(/Ninguém pediu para zerar/);
      return { text: "Quer que eu zere o Caixa - Thamires (R$ 100,00) e o Nubank - Thamires (-R$ 1.027,75)?", calls: [] };
    });
    await sendMessage(wa, { text: "como estão os saldos?" });
    fake.script.push(async () => ({ text: "Vou zerar o Caixa - Thamires (R$ 100,00) e o Nubank - Thamires (-R$ 1.027,75). Confirma?", calls: [] }));
    await sendMessage(wa, { text: "zera tudo" });
    fake.script.push(async (req) => {
      const out = (await req.execute("zerar_saldos", { contas: null })) as { zeradas: Array<{ conta: string; saldo_anterior: string }>; ja_estavam_zeradas: number };
      expect(out.zeradas).toEqual([
        { conta: "Caixa - Thamires", saldo_anterior: "R$ 100,00", saldo_agora: "R$ 0,00" },
        { conta: "Nubank - Thamires", saldo_anterior: "-R$ 1.027,75", saldo_agora: "R$ 0,00" },
      ]);
      expect(out.ja_estavam_zeradas).toBe(1);
      return { text: "Pronto, zerei as duas contas.", calls: ["zerar_saldos"] };
    });
    await sendMessage(wa, { text: "sim" });
    expect((await listAccounts(wa.ctx)).map((a) => a.balanceCents)).toEqual([0, 0, 0]);
    const adj = await prisma.transaction.findMany({ where: { householdId: wa.householdId, type: "ADJUSTMENT" } });
    expect(adj.map((t) => t.amountCents).sort((a, b) => a - b)).toEqual([10_000, 102_775]);
  });

  it("ajustar saldo: valor proposto pela Isa e confirmado com 'sim' vale; sem confirmação, não", async () => {
    const wa = await aiFamily();
    await createAccount(wa.ctx, { name: "Caixa", type: "WALLET", initialBalanceCents: 10_000 });
    await createAccount(wa.ctx, { name: "Banco", type: "CHECKING", initialBalanceCents: 45_000 });
    fake.script.push(async (req) => {
      // Ninguém disse 450: sem confirmação, recusado.
      await expect(req.execute("ajustar_saldo", { conta: "Caixa", saldo: 450, data: null })).rejects.toThrow(/não aparece/);
      return { text: "Quer que eu ajuste o *Caixa* para R$ 450,00, igual ao Banco?", calls: [] };
    });
    await sendMessage(wa, { text: "deixa o caixa igual ao banco" });
    fake.script.push(async (req) => {
      // Outro valor que não foi proposto continua recusado.
      await expect(req.execute("ajustar_saldo", { conta: "Caixa", saldo: 999, data: null })).rejects.toThrow(/não aparece/);
      await req.execute("ajustar_saldo", { conta: "Caixa", saldo: 450, data: null });
      return { text: "Pronto, o Caixa está com R$ 450,00.", calls: ["ajustar_saldo"] };
    });
    await sendMessage(wa, { text: "sim" });
    expect((await listAccounts(wa.ctx)).find((a) => a.name === "Caixa")!.balanceCents).toBe(45_000);
  });

  it("valor dito num áudio vale na resposta seguinte por texto (o histórico usa a transcrição)", async () => {
    const wa = await aiFamily();
    await createAccount(wa.ctx, { name: "Hian", type: "DIGITAL", initialBalanceCents: 0 });
    // Uma mensagem anterior vira o áudio "ajusta o caixa Hian para 258,74" (transcrição criptografada).
    fake.script.push(async () => ({ text: "Qual conta é o caixa Hian?", calls: [] }));
    const audio = await sendMessage(wa, { text: "x" });
    const att = await prisma.attachment.create({
      data: { householdId: wa.householdId, kind: "AUDIO", mimeType: "audio/ogg", sizeBytes: 10, sha256: "a".repeat(64), transcription: encryptString("Ajusta o Caixa, Hian, para R$ 258,74") },
    });
    await prisma.whatsAppMessage.update({ where: { id: audio.messageId }, data: { type: "AUDIO", text: null, attachmentId: att.id } });
    fake.script.push(async (req) => {
      expect(req.messages[0]!.content).toContain("258,74");
      await req.execute("ajustar_saldo", { conta: "Hian", saldo: 258.74, data: null });
      await req.execute("renomear_conta", { conta: "Hian", novo_nome: "Caixa - Hian" });
      return { text: "Pronto, a conta Hian está com R$ 258,74.", calls: ["ajustar_saldo"] };
    });
    await sendMessage(wa, { text: "tem um caixa Hian sim, é o nubank" });
    expect((await listAccounts(wa.ctx)).find((a) => a.name === "Caixa - Hian")!.balanceCents).toBe(25_874);
  });

  it("pacote de organização: orçamento, recorrência, regra, cartão, meta de receita e recibo com o total do mês", async () => {
    const wa = await aiFamily();
    await createAccount(wa.ctx, { name: "C6 Bank", type: "CHECKING", initialBalanceCents: 100_000 });
    fake.script.push(async (req) => {
      const orc = (await req.execute("definir_orcamento", { categoria: "Alimentação", valor: 800, mes: null })) as { limite: string; resta: string };
      expect(orc).toMatchObject({ limite: "R$ 800,00", resta: "R$ 800,00" });
      await expect(req.execute("definir_orcamento", { categoria: "Alimentação", valor: 950, mes: null })).rejects.toThrow(/não aparece/);
      const rec = (await req.execute("criar_recorrencia", {
        tipo: "despesa", descricao: "Academia", valor: 89.9, frequencia: "semanal", dia_do_mes: null, dia_da_semana: "segunda",
        categoria: null, conta: "C6 Bank", cartao: null, lancar_automatico: true, valor_variavel: false,
      })) as { criada: string; lanca_sozinho: boolean };
      expect(rec).toMatchObject({ criada: "Academia", lanca_sozinho: true });
      await req.execute("criar_regra", { palavra: "guincho", categoria: "Transporte", tipo: "despesa" });
      const card = (await req.execute("cadastrar_cartao", { nome: "Nubank", dia_fechamento: 20, dia_vencimento: 27, limite: null, conta_pagamento: "C6 Bank" })) as { cartao_criado: string };
      expect(card.cartao_criado).toBe("Nubank");
      await expect(req.execute("cadastrar_cartao", { nome: "Nubank", dia_fechamento: 1, dia_vencimento: 8, limite: null, conta_pagamento: null })).rejects.toThrow(/Já existe/);
      const meta = (await req.execute("meta_de_receita", { valor: 15000, natureza: null })) as { meta: string; recorte: string };
      expect(meta).toMatchObject({ meta: "R$ 15.000,00", recorte: "pessoal" });
      // Recibo: gasto em Alimentação mostra o total do mês e o orçamento.
      const out = (await req.execute("registrar_lancamentos", {
        lancamentos: [{ tipo: "despesa", valor: 120, descricao: "Mercado", data: null, categoria: "Alimentação", conta: "C6 Bank", cartao: null, forma_pagamento: "PIX", parcelas: null, pessoa: null, natureza: null }],
      })) as { resultados: Array<{ no_mes: string | null }> };
      expect(out.resultados[0]!.no_mes).toBe("Alimentação no mês: R$ 120,00 de R$ 800,00 (15%), restam R$ 680,00");
      const rep = (await req.execute("gastos_que_se_repetem", {})) as { encontrados: unknown[] };
      expect(Array.isArray(rep.encontrados)).toBe(true);
      return { text: "Feito: orçamento, academia, regra do guincho, cartão Nubank e meta de 15 mil. Mercado R$ 120,00 · Alimentação no mês: R$ 120,00 de R$ 800,00.", calls: [] };
    });
    await sendMessage(wa, { text: "define 800 pra alimentação, toda segunda tem 89,90 da academia ja deixa lançado no c6, guincho é sempre transporte, cadastra meu cartão nubank fecha dia 20 e vence 27, minha meta de receita é 15000, e gastei 120 no mercado" });
    const month = new Date().toISOString().slice(0, 7);
    expect(await prisma.budget.count({ where: { householdId: wa.householdId, month, limitCents: 80_000 } })).toBe(1);
    const rec = await prisma.recurringTransaction.findFirstOrThrow({ where: { householdId: wa.householdId, description: "Academia" } });
    expect([rec.amountCents, rec.frequency, rec.autoPost]).toEqual([8_990, "WEEKLY", true]);
    expect(new Date(rec.startDate).getUTCDay()).toBe(1); // segunda-feira
    expect(await prisma.financialRule.count({ where: { householdId: wa.householdId, pattern: "guincho" } })).toBe(1);
    expect(await prisma.creditCard.count({ where: { householdId: wa.householdId, name: "Nubank", closingDay: 20, dueDay: 27 } })).toBe(1);
    expect(await prisma.incomeGoal.count({ where: { householdId: wa.householdId, targetCents: 1_500_000, active: true } })).toBe(1);
  });

  it("relatório sob encomenda: 'excel só dos gastos no pix' vai para a Isa; o padrão do mês continua no comando fixo", async () => {
    const wa = await aiFamily();
    const c6 = await createAccount(wa.ctx, { name: "C6 Bank", type: "CHECKING", initialBalanceCents: 100_000 });
    const today = new Date().toISOString().slice(0, 10);
    await createTransaction(wa.ctx, { type: "EXPENSE", amountCents: 5_000, description: "Feira no pix", date: today, accountId: c6.id, paymentMethod: "PIX" });
    await createTransaction(wa.ctx, { type: "EXPENSE", amountCents: 3_000, description: "Padaria no débito", date: today, accountId: c6.id, paymentMethod: "DEBIT_CARD" });
    const priv = await createAccount(wa.wifeCtx, { name: "Conta da Maria", visibility: "PRIVATE", initialBalanceCents: 0 });
    await createTransaction(wa.wifeCtx, { type: "EXPENSE", amountCents: 9_900, description: "Presente no pix", date: today, accountId: priv.id, paymentMethod: "PIX" });

    // O padrão ("relatório do mês") segue no comando fixo, sem chamar a IA.
    await sendMessage(wa, { text: "manda o relatório do mês" });
    expect(fake.requests).toHaveLength(0);

    fake.script.push(async (req) => {
      const out = (await req.execute("gerar_relatorio", { inicio: `${today.slice(0, 7)}-01`, fim: today, tipo: "gastos", formato: "planilha", categoria: null, forma_pagamento: "PIX", conta: null, cartao: null })) as { lancamentos: number; total: string };
      // Só o Pix da família: o Pix da conta privada da Maria não entra no grupo.
      expect(out).toMatchObject({ lancamentos: 1, total: "R$ 50,00" });
      await expect(req.execute("gerar_relatorio", { inicio: "2030-01-01", fim: "2030-01-31", tipo: "gastos", formato: "pdf", categoria: null, forma_pagamento: null, conta: null, cartao: null })).rejects.toThrow(/ainda não começou/);
      return { text: "Pronto, mandei a planilha dos gastos no Pix deste mês.", calls: ["gerar_relatorio"] };
    });
    const m = await sendMessage(wa, { text: "manda um excel só dos gastos no pix desse mês" });
    const reply = (await messageState(wa, m.messageId)).reply ?? "";
    expect(reply).toContain("Pronto, mandei a planilha");
    expect(reply).toMatch(/📎 gastos-no-pix_\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.xlsx/);
  });

  it("gráfico no WhatsApp: imagem PNG por mês (categorias comparadas) e por categoria; números do painel", async () => {
    const wa = await aiFamily();
    const c6 = await createAccount(wa.ctx, { name: "C6 Bank", type: "CHECKING", initialBalanceCents: 100_000 });
    const today = new Date().toISOString().slice(0, 10);
    const food = await categoryId(wa.householdId, "Alimentação");
    const transport = await categoryId(wa.householdId, "Transporte");
    await createTransaction(wa.ctx, { type: "EXPENSE", amountCents: 4_500, description: "iFood", date: today, accountId: c6.id, categoryId: food });
    await createTransaction(wa.ctx, { type: "EXPENSE", amountCents: 2_390, description: "Uber", date: today, accountId: c6.id, categoryId: transport });
    fake.script.push(async (req) => {
      const out = (await req.execute("grafico", { tipo: "por_mes", valores: "gastos", meses: 3, categorias: ["Alimentação", "Transporte"], inicio: null, fim: null })) as { numeros: Array<{ serie: string; por_mes: string[] }> };
      expect(out.numeros.map((s) => [s.serie, s.por_mes.at(-1)])).toEqual([
        ["Alimentação", `${today.slice(0, 7)}: R$ 45,00`],
        ["Transporte", `${today.slice(0, 7)}: R$ 23,90`],
      ]);
      await expect(req.execute("grafico", { tipo: "por_mes", valores: "gastos", meses: 3, categorias: ["Inventada"], inicio: null, fim: null })).rejects.toThrow(/não existe/);
      const cat = (await req.execute("grafico", { tipo: "por_categoria", valores: "gastos", meses: null, categorias: null, inicio: null, fim: null })) as { numeros: string[] };
      expect(cat.numeros).toEqual(["Alimentação: R$ 45,00", "Transporte: R$ 23,90"]);
      return { text: "Mandei os gráficos: alimentação está acima de transporte neste mês.", calls: ["grafico", "grafico"] };
    });
    const m = await sendMessage(wa, { text: "compara alimentação e transporte nos últimos 3 meses e manda um gráfico por categoria" });
    const reply = (await messageState(wa, m.messageId)).reply ?? "";
    expect(reply.match(/📎 grafico\.png/g)).toHaveLength(2);
    // Os arquivos são PNG de verdade.
    const pngs = await prisma.whatsAppMessage.findMany({ where: { householdId: wa.householdId, direction: "OUTBOUND", text: { contains: "grafico.png" } } });
    expect(pngs.length).toBeGreaterThanOrEqual(1);
  });

  it("apagar em lote: primeiro conta e pergunta; só apaga depois do 'sim' (e vai para a lixeira)", async () => {
    const wa = await aiFamily();
    const c6 = await createAccount(wa.ctx, { name: "C6 Bank", type: "CHECKING", initialBalanceCents: 100_000 });
    for (const [desc, cents, date] of [["Teste 1", 1_000, "2026-07-03"], ["Teste 2", 2_000, "2026-07-20"], ["Agosto fica", 3_000, "2026-08-02"]] as const) {
      await createTransaction(wa.ctx, { type: "EXPENSE", amountCents: cents, description: desc, date, accountId: c6.id });
    }
    const args = { inicio: "2026-07-01", fim: "2026-07-31", contem: null, tipo: "todos", confirmado: true };
    fake.script.push(async (req) => {
      // Mesmo pedindo confirmado=true, sem o "sim" da pessoa nada é apagado.
      const first = (await req.execute("apagar_varios", args)) as { encontrados: number; apagado: boolean };
      expect(first).toMatchObject({ encontrados: 2, apagado: false });
      return { text: "Encontrei dois lançamentos de julho (R$ 30,00). Posso apagar os dois? Eles vão para a lixeira.", calls: ["apagar_varios"] };
    });
    await sendMessage(wa, { text: "apaga todos os lançamentos de julho, foi teste" });
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId, deletedAt: { not: null } } })).toBe(0);
    fake.script.push(async (req) => {
      const done = (await req.execute("apagar_varios", args)) as { apagados: number };
      expect(done.apagados).toBe(2);
      return { text: "Pronto, apaguei os 2 lançamentos de julho. Estão na lixeira.", calls: ["apagar_varios"] };
    });
    await sendMessage(wa, { text: "sim" });
    const left = await prisma.transaction.findMany({ where: { householdId: wa.householdId, deletedAt: null, type: "EXPENSE" } });
    expect(left.map((t) => t.description)).toEqual(["Agosto fica"]);
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId, deletedAt: { not: null } } })).toBe(2);
  });

  it("na tela do app, a Isa também registra (mesmas ferramentas) e marca a resposta como alteração", async () => {
    const wa = await aiFamily();
    await createAccount(wa.ctx, { name: "Caixa", type: "WALLET", initialBalanceCents: 0 });
    fake.script.push(async (req) => {
      expect(req.system).toContain("dentro do app da família");
      expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["registrar_lancamentos", "ajustar_saldo", "transferir", "saldos"]));
      await req.execute("ajustar_saldo", { conta: "Caixa", saldo: 820.5, data: null });
      return { text: "Anotei: o **Caixa** está com R$ 820,50.", calls: ["ajustar_saldo"] };
    });
    const res = await ask(wa.ctx, { question: "o caixa ficou com 820,50" });
    expect(res.assistantMessage.content).toBe("Anotei: o **Caixa** está com R$ 820,50.");
    expect(res.assistantMessage.metadata).toMatchObject({ changed: true, tools: ["ajustar_saldo"] });
    expect((await listAccounts(wa.ctx)).find((a) => a.name === "Caixa")!.balanceCents).toBe(82_050);
  });

  it("sem consentimento ou acima do teto do mês: motor local; provedor falhou sem ação: motor local também", async () => {
    const wa = await createWaFamily();
    expect(await agentAvailable(wa.ctx)).toBe(false);
    const m = await sendMessage(wa, { text: "gastei 50 no mercado" });
    expect((await messageState(wa, m.messageId)).reply).toContain("R$ 50,00");
    expect(fake.requests).toHaveLength(0);

    const wa2 = await aiFamily();
    expect(await agentAvailable(wa2.ctx)).toBe(true);
    // Falha do provedor antes de qualquer ação → o motor local registra.
    fake.script.push(async () => {
      throw new Error("sobrecarga");
    });
    const m2 = await sendMessage(wa2, { text: "gastei 30 na padaria" });
    expect((await messageState(wa2, m2.messageId)).reply).toContain("R$ 30,00");
    expect(await prisma.transaction.count({ where: { householdId: wa2.householdId } })).toBe(1);

    await prisma.aIProcessingLog.createMany({
      data: Array.from({ length: 300 }, () => ({ householdId: wa2.householdId, task: "ASSISTANT" as const, provider: "ANTHROPIC" as const, model: "x", status: "SUCCESS" as const, latencyMs: 1 })),
    });
    expect(await agentAvailable(wa2.ctx)).toBe(false);
  });

  it("formato do WhatsApp", () => {
    expect(toWhatsAppText("## Resumo\n**R$ 10,00** de mercado\n\n\n\nok")).toBe("Resumo\n*R$ 10,00* de mercado\n\nok");
  });
});

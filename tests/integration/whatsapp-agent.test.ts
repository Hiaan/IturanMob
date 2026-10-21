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
import { agentAvailable, toWhatsAppText } from "@/server/ai/agent/whatsapp-agent";
import { createWaFamily, enableExternalAI, initTestQueues, clearTestQueues, messageState, sendMessage, teardownTestQueues, type WaFamily } from "./ai-pipeline-support";
import { resetDatabase } from "./helpers";

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

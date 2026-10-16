import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../env";
import { AIProviderError, type LLMProvider, type StructuredRequest, type ToolLoopRequest, type UserContentPart, type Usage } from "./types";

/**
 * Provedor Anthropic (Claude). Usa structured outputs (output_config.format) para extração
 * e um loop manual de ferramentas para o assistente (ferramentas somente leitura, validadas).
 * Fallback de recusa habilitado no servidor ("fallbacks: default").
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function toContent(parts: UserContentPart[]): Anthropic.Beta.BetaContentBlockParam[] {
  return parts.map((p): Anthropic.Beta.BetaContentBlockParam => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "document") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } };
    return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } };
  });
}

function mapError(err: unknown): AIProviderError {
  if (err instanceof Anthropic.RateLimitError) return new AIProviderError("Limite de requisições do provedor de IA atingido.", true);
  if (err instanceof Anthropic.AuthenticationError) return new AIProviderError("Chave de API da Anthropic inválida.", false);
  if (err instanceof Anthropic.BadRequestError) return new AIProviderError(`Requisição rejeitada pelo provedor: ${err.message.slice(0, 200)}`, false);
  if (err instanceof Anthropic.APIConnectionError) return new AIProviderError("Falha de conexão com o provedor de IA.", true);
  if (err instanceof Anthropic.APIError) return new AIProviderError(`Erro do provedor de IA (${err.status ?? "?"}).`, (err.status ?? 500) >= 500);
  return new AIProviderError((err as Error)?.message ?? "Erro desconhecido do provedor de IA.", true);
}

export class AnthropicProvider implements LLMProvider {
  readonly type = "ANTHROPIC" as const;
  readonly supportsVision = true;
  readonly supportsDocuments = true;
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: env().AI_TIMEOUT_MS, maxRetries: 2 });
  }

  async structured(req: StructuredRequest): Promise<{ json: unknown; usage: Usage }> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: toContent(req.user) }],
        output_config: { format: { type: "json_schema", schema: req.jsonSchema }, effort: req.effort ?? "low" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal") throw new AIProviderError("O provedor de IA recusou processar esta mensagem.", false);
      if (response.stop_reason === "max_tokens") throw new AIProviderError("Resposta do provedor de IA truncada.", true);
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { json: JSON.parse(text), usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      if (err instanceof SyntaxError) throw new AIProviderError("Resposta do provedor de IA em formato inválido.", true);
      throw mapError(err);
    }
  }

  async runTools(req: ToolLoopRequest) {
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const toolCalls: Array<{ name: string; input: unknown; ok: boolean }> = [];
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const max = req.maxIterations ?? 8;
    try {
      for (let i = 0; i < max; i++) {
        const response = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: req.maxTokens ?? 8000,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          tools,
          tool_choice: { type: "auto" },
          messages,
          output_config: { effort: "medium" },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        });
        usage.inputTokens! += response.usage.input_tokens;
        usage.outputTokens! += response.usage.output_tokens;
        if (response.stop_reason === "refusal") throw new AIProviderError("O provedor de IA recusou esta consulta.", false);
        // Preserva o conteúdo completo (inclui blocos de raciocínio) ao continuar o loop.
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (response.stop_reason === "pause_turn") continue;
        const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (response.stop_reason !== "tool_use" || !toolUses.length) {
          const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
          return { text, toolCalls, usage };
        }
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          try {
            const out = await req.execute(tu.name, tu.input);
            toolCalls.push({ name: tu.name, input: tu.input, ok: true });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
          } catch (e) {
            toolCalls.push({ name: tu.name, input: tu.input, ok: false });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: `Erro: ${(e as Error).message}`, is_error: true });
          }
        }
        messages.push({ role: "user", content: results });
      }
      throw new AIProviderError("Limite de etapas do assistente atingido.", false);
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      throw mapError(err);
    }
  }
}

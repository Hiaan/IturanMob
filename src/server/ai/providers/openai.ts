import OpenAI from "openai";
import { env } from "../../env";
import { AIProviderError, type LLMProvider, type StructuredRequest, type ToolLoopRequest, type Usage } from "./types";

/** Provedor OpenAI (ou compatível, via baseURL). */
function mapError(err: unknown): AIProviderError {
  if (err instanceof OpenAI.RateLimitError) return new AIProviderError("Limite de requisições do provedor de IA atingido.", true);
  if (err instanceof OpenAI.AuthenticationError) return new AIProviderError("Chave de API da OpenAI inválida.", false);
  if (err instanceof OpenAI.BadRequestError) return new AIProviderError(`Requisição rejeitada pelo provedor: ${err.message.slice(0, 200)}`, false);
  if (err instanceof OpenAI.APIConnectionError) return new AIProviderError("Falha de conexão com o provedor de IA.", true);
  if (err instanceof OpenAI.APIError) return new AIProviderError(`Erro do provedor de IA (${err.status ?? "?"}).`, (err.status ?? 500) >= 500);
  return new AIProviderError((err as Error)?.message ?? "Erro desconhecido do provedor de IA.", true);
}

export class OpenAIProvider implements LLMProvider {
  readonly supportsVision = true;
  private client: OpenAI;

  constructor(
    readonly type: "OPENAI" | "OPENAI_COMPATIBLE",
    apiKey: string,
    readonly model: string,
    baseURL?: string | null,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: baseURL || undefined, timeout: env().AI_TIMEOUT_MS, maxRetries: 2 });
  }

  async structured(req: StructuredRequest): Promise<{ json: unknown; usage: Usage }> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: req.maxTokens ?? 4096,
        messages: [
          { role: "system", content: req.system },
          {
            role: "user",
            content: req.user.map((p) =>
              p.type === "text" ? { type: "text" as const, text: p.text } : { type: "image_url" as const, image_url: { url: `data:${p.mediaType};base64,${p.base64}` } },
            ),
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: true } },
      });
      const choice = response.choices[0];
      if (!choice?.message.content) throw new AIProviderError(choice?.message.refusal ? "O provedor de IA recusou processar esta mensagem." : "Resposta vazia do provedor de IA.", false);
      return { json: JSON.parse(choice.message.content), usage: { inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens } };
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      if (err instanceof SyntaxError) throw new AIProviderError("Resposta do provedor de IA em formato inválido.", true);
      throw mapError(err);
    }
  }

  async runTools(req: ToolLoopRequest) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))];
    const tools: OpenAI.Chat.ChatCompletionTool[] = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const toolCalls: Array<{ name: string; input: unknown; ok: boolean }> = [];
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for (let i = 0; i < (req.maxIterations ?? 8); i++) {
        const response = await this.client.chat.completions.create({ model: this.model, messages, tools, tool_choice: "auto", max_completion_tokens: req.maxTokens ?? 4000 });
        usage.inputTokens! += response.usage?.prompt_tokens ?? 0;
        usage.outputTokens! += response.usage?.completion_tokens ?? 0;
        const msg = response.choices[0]?.message;
        if (!msg) throw new AIProviderError("Resposta vazia do provedor de IA.", true);
        messages.push(msg);
        const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
        if (!calls.length) return { text: (msg.content ?? "").trim(), toolCalls, usage };
        for (const call of calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.function.arguments || "{}");
            const out = await req.execute(call.function.name, input);
            toolCalls.push({ name: call.function.name, input, ok: true });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
          } catch (e) {
            toolCalls.push({ name: call.function.name, input, ok: false });
            messages.push({ role: "tool", tool_call_id: call.id, content: `Erro: ${(e as Error).message}` });
          }
        }
      }
      throw new AIProviderError("Limite de etapas do assistente atingido.", false);
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      throw mapError(err);
    }
  }
}

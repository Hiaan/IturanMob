import type { AIProviderType, AITask } from "@prisma/client";

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; base64: string }
  /** PDF inteiro (ex.: extrato digitalizado). Só para provedores com supportsDocuments. */
  | { type: "document"; mediaType: "application/pdf"; base64: string; filename?: string };

export interface StructuredRequest {
  task: AITask;
  system: string;
  user: UserContentPart[];
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolLoopRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: ToolDefinition[];
  /** Executa a ferramenta (o chamador valida a entrada). Deve retornar dados serializáveis. */
  execute: (name: string, input: unknown) => Promise<unknown>;
  maxIterations?: number;
  maxTokens?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMProvider {
  type: AIProviderType;
  model: string;
  supportsVision: boolean;
  /** Aceita PDF como entrada (leitura de extratos digitalizados). */
  supportsDocuments?: boolean;
  structured(req: StructuredRequest): Promise<{ json: unknown; usage: Usage }>;
  runTools(req: ToolLoopRequest): Promise<{ text: string; toolCalls: Array<{ name: string; input: unknown; ok: boolean }>; usage: Usage }>;
}

export class AIProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "AIProviderError";
    this.retryable = retryable;
  }
}

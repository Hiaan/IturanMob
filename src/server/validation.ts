import type { z } from "zod";

/**
 * Edição parcial (PATCH): devolve só os campos enviados. No Zod 4, `.partial()` ainda aplica os
 * `.default()` dos campos ausentes — sem isto, editar só a descrição voltaria o parcelamento para 1x
 * e arquivar uma conta mudaria o tipo dela para "corrente".
 */
export function parsePatch<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.parse(input) as Record<string, unknown>;
  if (!input || typeof input !== "object") return parsed as z.output<S>;
  const provided = input as Record<string, unknown>;
  for (const key of Object.keys(parsed)) if (!(key in provided) || provided[key] === undefined) delete parsed[key];
  return parsed as z.output<S>;
}

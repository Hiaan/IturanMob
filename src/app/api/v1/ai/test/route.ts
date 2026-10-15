import { z } from "zod";
import { authed } from "@/server/api/handler";
import { testProvider } from "@/server/ai/api";

export const POST = authed(
  { body: z.object({ provider: z.enum(["ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE"]), model: z.string().max(100).optional() }), permission: "integrations:manage", rateLimit: { key: "ai-test", limit: 10, windowSeconds: 600 } },
  async ({ ctx, body }) => testProvider(ctx, body.provider, body.model),
);

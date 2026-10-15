import { z } from "zod";
import { authed } from "@/server/api/handler";
import { credentialSchema, deleteCredential, saveCredential } from "@/server/ai/api";

export const PUT = authed({ body: credentialSchema, permission: "integrations:manage", rateLimit: { key: "ai-cred", limit: 20, windowSeconds: 600 } }, async ({ ctx, body }) => saveCredential(ctx, body));
export const DELETE = authed({ query: z.object({ provider: z.enum(["ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE"]) }), permission: "integrations:manage" }, async ({ ctx, query }) =>
  deleteCredential(ctx, query.provider),
);

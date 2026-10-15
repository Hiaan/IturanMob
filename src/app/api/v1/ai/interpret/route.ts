import { authed } from "@/server/api/handler";
import { previewText, textSchema } from "@/server/ai/api";

export const POST = authed({ body: textSchema, rateLimit: { key: "ai-interpret", limit: 60, windowSeconds: 60 } }, async ({ ctx, body }) => previewText(ctx, body.text));

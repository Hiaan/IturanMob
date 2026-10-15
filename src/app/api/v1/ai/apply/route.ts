import { authed } from "@/server/api/handler";
import { applyText, textSchema } from "@/server/ai/api";

export const POST = authed({ body: textSchema, permission: "transactions:write", rateLimit: { key: "ai-apply", limit: 30, windowSeconds: 60 } }, async ({ ctx, body }) => applyText(ctx, body.text));

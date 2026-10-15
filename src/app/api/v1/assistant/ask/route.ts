import { authed } from "@/server/api/handler";
import { ask, askSchema } from "@/server/ai/assistant/service";

export const POST = authed({ body: askSchema, rateLimit: { key: "assistant", limit: 30, windowSeconds: 60 } }, async ({ ctx, body }) => ask(ctx, body));

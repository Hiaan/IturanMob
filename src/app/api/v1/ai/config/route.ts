import { authed } from "@/server/api/handler";
import { getAIConfig } from "@/server/ai/api";

export const GET = authed({}, async ({ ctx }) => getAIConfig(ctx));

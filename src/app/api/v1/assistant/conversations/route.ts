import { authed } from "@/server/api/handler";
import { listConversations } from "@/server/ai/assistant/service";

export const GET = authed({}, async ({ ctx }) => listConversations(ctx));

import { authed } from "@/server/api/handler";
import { deleteConversation, getConversation } from "@/server/ai/assistant/service";

export const GET = authed({}, async ({ ctx, params }) => getConversation(ctx, params.id!));
export const DELETE = authed({}, async ({ ctx, params }) => {
  await deleteConversation(ctx, params.id!);
  return { ok: true };
});

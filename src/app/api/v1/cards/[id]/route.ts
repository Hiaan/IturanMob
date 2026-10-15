import { authed } from "@/server/api/handler";
import { cardUpdateSchema, deleteCard, updateCard } from "@/server/modules/cards/service";

export const PATCH = authed({ body: cardUpdateSchema, permission: "cards:write" }, async ({ ctx, params, body }) => updateCard(ctx, params.id!, body));
export const DELETE = authed({ permission: "cards:write" }, async ({ ctx, params }) => {
  await deleteCard(ctx, params.id!);
  return { ok: true };
});

import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { cardSchema, createCard, listCards } from "@/server/modules/cards/service";

export const GET = authed({ query: z.object({ includeArchived: qs.bool() }) }, async ({ ctx, query }) => listCards(ctx, { includeArchived: query.includeArchived }));
export const POST = authed({ body: cardSchema, permission: "cards:write" }, async ({ ctx, body }) => createCard(ctx, body));

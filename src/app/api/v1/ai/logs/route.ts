import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { listAILogs } from "@/server/ai/api";

export const GET = authed({ query: z.object({ limit: qs.int(50) }), permission: "integrations:manage" }, async ({ ctx, query }) => listAILogs(ctx, query.limit));

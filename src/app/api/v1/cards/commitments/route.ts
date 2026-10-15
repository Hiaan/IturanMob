import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { futureCommitments } from "@/server/modules/cards/service";

export const GET = authed({ query: z.object({ months: qs.int(12) }) }, async ({ ctx, query }) => futureCommitments(ctx, query.months));

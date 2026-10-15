import { authed } from "@/server/api/handler";
import { pendingCounts } from "@/server/modules/pending/service";

export const GET = authed({}, async ({ ctx }) => pendingCounts(ctx));

import { authed } from "@/server/api/handler";
import { syncNow } from "@/server/modules/open-finance/service";

/** POST → busca agora os lançamentos novos das contas ligadas. */
export const POST = authed(
  { permission: "integrations:manage", rateLimit: { key: "open-finance:sync", limit: 10, windowSeconds: 600 } },
  async ({ ctx }) => syncNow(ctx),
);

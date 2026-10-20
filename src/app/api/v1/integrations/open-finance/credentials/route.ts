import { authed } from "@/server/api/handler";
import { openFinanceCredentialsSchema, saveOpenFinanceCredentials } from "@/server/modules/open-finance/service";

/** PUT { provider, clientId?, clientSecret? } → confere na Pluggy e salva cifrado. */
export const PUT = authed(
  { body: openFinanceCredentialsSchema, permission: "integrations:manage", rateLimit: { key: "open-finance:credentials", limit: 10, windowSeconds: 600 } },
  async ({ ctx, body }) => saveOpenFinanceCredentials(ctx, body),
);

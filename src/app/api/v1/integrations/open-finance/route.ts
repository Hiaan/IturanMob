import { authed } from "@/server/api/handler";
import { getOpenFinanceStatus, removeOpenFinanceConnection } from "@/server/modules/open-finance/service";

/** GET → situação da conexão com bancos (sem credenciais). DELETE → remove a conexão (lançamentos ficam). */
export const GET = authed({ permission: "integrations:manage" }, async ({ ctx }) => getOpenFinanceStatus(ctx));
export const DELETE = authed({ permission: "integrations:manage" }, async ({ ctx }) => removeOpenFinanceConnection(ctx));

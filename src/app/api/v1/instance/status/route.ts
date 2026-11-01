import { authed } from "@/server/api/handler";
import { getPlatformStatus } from "@/server/modules/instance/platform";

/** Painel da instalação: versão, atualização automática e saúde (só o administrador). */
export const GET = authed({}, async ({ ctx }) => getPlatformStatus(ctx));

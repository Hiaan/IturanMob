import { authed } from "@/server/api/handler";
import { requestUpdate } from "@/server/modules/instance/platform";

/** "Atualizar agora": o servidor instala a versão disponível em até 5 minutos. */
export const POST = authed({ rateLimit: { key: "instance-update", limit: 10, windowSeconds: 3600 } }, async ({ ctx }) => requestUpdate(ctx));

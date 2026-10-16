import { authed } from "@/server/api/handler";
import { listPushDevices, pushConfig } from "@/server/modules/push/service";

/** Configuração do push (chave pública VAPID) e os aparelhos inscritos do membro logado. */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx }) => ({ ...pushConfig(), devices: await listPushDevices(ctx) }));

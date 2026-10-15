import { authed } from "@/server/api/handler";
import { getQrCode } from "@/server/whatsapp/service";

export const dynamic = "force-dynamic";

/** QR Code atual como data URL (gerado no servidor). 404 se não houver QR pendente. */
export const GET = authed({ permission: "integrations:manage" }, async ({ ctx }) => getQrCode(ctx));

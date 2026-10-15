import { authed } from "@/server/api/handler";
import { getWhatsAppStatus } from "@/server/whatsapp/service";

export const dynamic = "force-dynamic";

/** Status completo da integração com o WhatsApp (leitura para todos os membros). */
export const GET = authed({}, async ({ ctx }) => getWhatsAppStatus(ctx));

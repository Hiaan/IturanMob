import { authed } from "@/server/api/handler";
import { listWhatsAppMessages, messagesQuerySchema } from "@/server/whatsapp/service";

export const dynamic = "force-dynamic";

export const GET = authed({ query: messagesQuerySchema }, async ({ ctx, query }) => listWhatsAppMessages(ctx, query));

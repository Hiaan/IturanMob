import { authed } from "@/server/api/handler";
import { announcementSchema, sendAnnouncement } from "@/server/modules/instance/platform";

/** Aviso para as famílias (prévia ou envio; o mesmo texto nunca sai duas vezes para a mesma família). */
export const POST = authed({ body: announcementSchema, rateLimit: { key: "instance-announce", limit: 30, windowSeconds: 3600 } }, async ({ ctx, body }) => sendAnnouncement(ctx, body));

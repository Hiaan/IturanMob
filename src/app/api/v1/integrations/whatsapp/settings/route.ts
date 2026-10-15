import { authed } from "@/server/api/handler";
import { updateWhatsAppSettings, whatsappSettingsSchema } from "@/server/whatsapp/service";

export const PATCH = authed({ body: whatsappSettingsSchema, permission: "integrations:manage" }, async ({ ctx, body }) => updateWhatsAppSettings(ctx, body));

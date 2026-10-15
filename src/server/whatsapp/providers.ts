import type { WhatsAppConnection } from "@prisma/client";
import { env } from "../env";
import { readConfig } from "./config";
import type { ProviderCallbacks, WhatsAppProvider } from "./types";

/**
 * Fábrica de provedores — usada SOMENTE no worker. Os provedores são carregados sob demanda
 * (o Baileys só é importado quando a família usa o provedor BAILEYS).
 */
export async function createProvider(conn: WhatsAppConnection, callbacks: ProviderCallbacks): Promise<WhatsAppProvider> {
  switch (conn.provider) {
    case "BAILEYS": {
      const { BaileysProvider } = await import("./baileys/provider");
      return new BaileysProvider({ connectionId: conn.id, callbacks });
    }
    case "CLOUD_API": {
      const { CloudApiProvider, cloudConfig } = await import("./cloud-api/provider");
      const cfg = cloudConfig(readConfig(conn.config));
      if (!cfg) throw new Error("Cloud API não configurada: defina WHATSAPP_CLOUD_ACCESS_TOKEN e WHATSAPP_CLOUD_PHONE_NUMBER_ID.");
      return new CloudApiProvider(cfg, callbacks);
    }
    case "SIMULATOR": {
      if (!env().WHATSAPP_ENABLE_SIMULATOR) throw new Error("Simulador desabilitado (WHATSAPP_ENABLE_SIMULATOR=false).");
      const { SimulatorProvider } = await import("./simulator/provider");
      return new SimulatorProvider({ householdId: conn.householdId, callbacks });
    }
    default:
      throw new Error("Provedor de WhatsApp desconhecido");
  }
}

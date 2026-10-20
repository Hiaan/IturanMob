import { randomUUID } from "node:crypto";
import { prisma } from "../../db";
import {
  PROVIDER_CAPABILITIES,
  SIMULATOR_NOTICE,
  type NormalizedInboundMessage,
  type ProviderCallbacks,
  type ProviderGroup,
  type OutboundDocument,
  type SendTextOptions,
  type WhatsAppProvider,
} from "../types";

/**
 * SIMULADOR DE DESENVOLVIMENTO — "Simulador — nenhuma conexão real com o WhatsApp".
 *
 * Não abre nenhuma conexão de rede. Expõe dois grupos simulados (família e empresa); as mensagens são injetadas
 * pela API de simulação e passam pelo MESMO fluxo de ingestão/processamento. As respostas do bot
 * são registradas como mensagens OUTBOUND no banco (visíveis na UI) — nada é enviado a ninguém.
 */

/** Id fixo do grupo simulado (não é um JID real). */
export const SIMULATOR_GROUP_ID = "simulador-financas-familia@g.us";
export const SIMULATOR_GROUP_NAME = "Finanças da Família (Simulador)";
/** Segundo grupo simulado, para testar um grupo da empresa (natureza própria). */
export const SIMULATOR_BUSINESS_GROUP_ID = "simulador-empresa@g.us";
export const SIMULATOR_BUSINESS_GROUP_NAME = "Empresa (Simulador)";
export const SIMULATOR_GROUP_IDS = [SIMULATOR_GROUP_ID, SIMULATOR_BUSINESS_GROUP_ID];

export class SimulatorProvider implements WhatsAppProvider {
  readonly type = "SIMULATOR" as const;
  readonly capabilities = PROVIDER_CAPABILITIES.SIMULATOR;
  private running = false;

  constructor(private readonly opts: { householdId: string; callbacks: ProviderCallbacks }) {}

  async start(): Promise<void> {
    this.running = true;
    await this.opts.callbacks.onStatus({ status: "CONNECTED", phoneNumber: null, displayName: SIMULATOR_NOTICE });
    await this.opts.callbacks.onGroups(await this.listGroups());
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async logout(): Promise<void> {
    this.running = false;
  }

  isConnected(): boolean {
    return this.running;
  }

  async sendText(_chatId: string, _text: string, _opts?: SendTextOptions): Promise<{ externalId: string }> {
    if (!this.running) throw new Error("Simulador parado");
    // Nenhum envio real: o consumidor registra a mensagem OUTBOUND simulada no banco.
    return { externalId: `SIM-OUT-${randomUUID()}` };
  }

  async sendDocument(_chatId: string, _doc: OutboundDocument, _opts?: SendTextOptions): Promise<{ externalId: string }> {
    if (!this.running) throw new Error("Simulador parado");
    // Nenhum envio real: o consumidor registra o envio simulado do arquivo no banco.
    return { externalId: `SIM-OUT-${randomUUID()}` };
  }

  async listGroups(): Promise<ProviderGroup[]> {
    const members = await prisma.householdMember.findMany({
      where: { householdId: this.opts.householdId, isActive: true, whatsappPhone: { not: null } },
      select: { whatsappPhone: true },
    });
    const participants = members.map((m) => ({ phone: m.whatsappPhone, jid: `${m.whatsappPhone!.replace(/\D/g, "")}@s.whatsapp.net` }));
    return [
      { externalId: SIMULATOR_GROUP_ID, name: SIMULATOR_GROUP_NAME, participantsCount: members.length, participants },
      { externalId: SIMULATOR_BUSINESS_GROUP_ID, name: SIMULATOR_BUSINESS_GROUP_NAME, participantsCount: members.length, participants },
    ];
  }

  /** Injeta uma mensagem simulada no fluxo normal (callback onMessage → ingestão). */
  async inject(msg: NormalizedInboundMessage) {
    if (!this.running) throw new Error("Simulador parado");
    return this.opts.callbacks.onMessage(msg);
  }
}

/** Monta uma mensagem simulada do membro num grupo simulado (padrão: o da família). */
export function buildSimulatedMessage(input: {
  phone: string;
  chatId?: string;
  text?: string | null;
  media?: { buffer: Buffer; mimeType: string; fileName?: string | null } | null;
  fromMe?: boolean;
  quotedExternalId?: string | null;
}): NormalizedInboundMessage {
  const digits = input.phone.replace(/\D/g, "");
  const media = input.media ?? null;
  let type: NormalizedInboundMessage["type"] = "TEXT";
  if (media) {
    if (media.mimeType.startsWith("audio/")) type = "AUDIO";
    else if (media.mimeType.startsWith("image/")) type = "IMAGE";
    else if (media.mimeType.startsWith("video/")) type = "VIDEO";
    else type = "DOCUMENT";
  }
  return {
    externalId: `SIM-${randomUUID()}`,
    chatId: input.chatId ?? SIMULATOR_GROUP_ID,
    isGroup: true,
    senderIds: { phone: `+${digits}`, jid: `${digits}@s.whatsapp.net` },
    fromMe: Boolean(input.fromMe),
    sentAt: new Date(),
    type,
    text: media ? null : (input.text ?? null),
    caption: media ? (input.text ?? null) : null,
    quotedExternalId: input.quotedExternalId ?? null,
    media: media
      ? {
          mimeType: media.mimeType,
          sizeBytes: media.buffer.length,
          fileName: media.fileName ?? null,
          download: async (maxBytes: number) => {
            if (media.buffer.length > maxBytes) throw new Error("Arquivo acima do limite de 16 MB");
            return media.buffer;
          },
        }
      : null,
  };
}

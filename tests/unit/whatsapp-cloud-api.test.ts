import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCloudWebhook, verifyCloudSignature } from "@/server/whatsapp/cloud-api/provider";

const SECRET = "app-secret-de-teste";

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "5581300000000", phone_number_id: "1098765" },
            contacts: [{ profile: { name: "Maria" }, wa_id: "5581999990002" }],
            messages: [
              { from: "5581999990002", id: "wamid.TEXT1", timestamp: "1760500000", type: "text", text: { body: "gastei 50 no mercado" } },
              {
                from: "5581999990002",
                id: "wamid.IMG1",
                timestamp: "1760500100",
                type: "image",
                image: { id: "MEDIA123", mime_type: "image/jpeg", caption: "comprovante" },
                context: { id: "wamid.TEXT1", from: "5581999990002" },
              },
              { from: "5581999990002", id: "wamid.R1", timestamp: "1760500200", type: "reaction", reaction: { message_id: "wamid.TEXT1", emoji: "👍" } },
            ],
          },
        },
        { field: "messages", value: { statuses: [{ id: "wamid.OUT", status: "delivered" }] } },
      ],
    },
  ],
};

describe("Cloud API: assinatura do webhook (X-Hub-Signature-256)", () => {
  const body = JSON.stringify(payload);

  it("aceita assinatura válida", () => {
    expect(verifyCloudSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyCloudSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it("recusa assinatura inválida, ausente, malformada ou de outro segredo", () => {
    expect(verifyCloudSignature(body, sign(body, "outro-segredo"), SECRET)).toBe(false);
    expect(verifyCloudSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyCloudSignature(body, null, SECRET)).toBe(false);
    expect(verifyCloudSignature(body, "sha256=abc", SECRET)).toBe(false);
    expect(verifyCloudSignature(body, sign(body).replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(verifyCloudSignature(body, sign(body), "")).toBe(false);
  });
});

describe("Cloud API: normalização do webhook", () => {
  it("converte mensagens em conversas diretas e ignora atualizações de status", () => {
    const parsed = parseCloudWebhook(payload, null);
    expect(parsed).toHaveLength(3);
    const [text, image, reaction] = parsed.map((p) => p.message);
    expect(parsed[0]!.phoneNumberId).toBe("1098765");
    expect(text).toMatchObject({
      externalId: "wamid.TEXT1",
      chatId: "5581999990002",
      isGroup: false,
      fromMe: false,
      type: "TEXT",
      text: "gastei 50 no mercado",
      senderIds: { phone: "+5581999990002" },
    });
    expect(text!.sentAt.toISOString()).toBe(new Date(1760500000 * 1000).toISOString());
    expect(image).toMatchObject({ type: "IMAGE", caption: "comprovante", quotedExternalId: "wamid.TEXT1" });
    // Sem configuração de mídia (credenciais), não há download.
    expect(image!.media).toBeNull();
    expect(reaction!.type).toBe("REACTION");
  });

  it("monta o download de mídia quando há credenciais", () => {
    const parsed = parseCloudWebhook(payload, { accessToken: "t", phoneNumberId: "1098765", apiVersion: "v21.0" });
    expect(parsed[1]!.message.media?.mimeType).toBe("image/jpeg");
    expect(typeof parsed[1]!.message.media?.download).toBe("function");
  });

  it("tolera payloads inválidos", () => {
    expect(parseCloudWebhook(null, null)).toEqual([]);
    expect(parseCloudWebhook({ entry: "x" }, null)).toEqual([]);
    expect(parseCloudWebhook({ entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x" }] } }] }] }, null)).toEqual([]);
  });
});

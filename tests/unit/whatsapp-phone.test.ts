import { describe, expect, it } from "vitest";
import {
  isGroupJid,
  isLidJid,
  isPnJid,
  jidFromPhone,
  maskPhone,
  normalizeE164,
  normalizeJid,
  phoneFromJid,
  phoneVariants,
  phonesMatch,
} from "@/server/whatsapp/phone";
import { mergeConfig, readConfig } from "@/server/whatsapp/config";
import { parseCommand } from "@/server/whatsapp/commands";
import { isProcessableType } from "@/server/whatsapp/ingest";

describe("whatsapp: telefones e JIDs", () => {
  it("normaliza para E.164", () => {
    expect(normalizeE164("+55 (81) 99999-0001")).toBe("+5581999990001");
    expect(normalizeE164("5581999990001")).toBe("+5581999990001");
    expect(normalizeE164("123")).toBeNull();
    expect(normalizeE164(null)).toBeNull();
  });

  it("considera o nono dígito brasileiro como equivalente", () => {
    expect(phoneVariants("+5581999990001")).toEqual(expect.arrayContaining(["+5581999990001", "+558199990001"]));
    expect(phonesMatch("+5581999990001", "+558199990001")).toBe(true);
    expect(phonesMatch("+558199990001", "+5581999990001")).toBe(true);
    expect(phonesMatch("+5581999990001", "+5581999990002")).toBe(false);
    expect(phonesMatch("+14155550100", "+14155550100")).toBe(true);
    expect(phonesMatch(null, "+14155550100")).toBe(false);
  });

  it("interpreta JIDs por telefone, LID e grupo", () => {
    expect(normalizeJid("5581999990001:12@s.whatsapp.net")).toBe("5581999990001@s.whatsapp.net");
    expect(normalizeJid("5581999990001@c.us")).toBe("5581999990001@s.whatsapp.net");
    expect(phoneFromJid("5581999990001:3@s.whatsapp.net")).toBe("+5581999990001");
    expect(phoneFromJid("123456789012345@lid")).toBeNull();
    expect(isLidJid("123456789012345@lid")).toBe(true);
    expect(isPnJid("5581999990001@s.whatsapp.net")).toBe(true);
    expect(isGroupJid("120363000000000001@g.us")).toBe(true);
    expect(jidFromPhone("+5581999990001")).toBe("5581999990001@s.whatsapp.net");
    expect(maskPhone("+5581999990001")).toBe("+5581*******01");
  });
});

describe("whatsapp: configuração e comandos", () => {
  it("lê e mescla a configuração não secreta", () => {
    const cfg = readConfig({ phoneNumberId: "123456", logoutRequestedAt: "2026-10-15T00:00:00.000Z", junk: 1 });
    expect(cfg).toEqual({ phoneNumberId: "123456", logoutRequestedAt: "2026-10-15T00:00:00.000Z" });
    expect(mergeConfig(cfg, { logoutRequestedAt: null, groupSyncRequestedAt: "x" })).toEqual({ phoneNumberId: "123456", groupSyncRequestedAt: "x" });
    expect(readConfig(null)).toEqual({});
    expect(readConfig([1, 2] as never)).toEqual({});
  });

  it("valida comandos do canal fa:wa:commands", () => {
    expect(parseCommand(JSON.stringify({ type: "connect", householdId: "h1", at: "t" }))).toEqual({ type: "connect", householdId: "h1", at: "t" });
    expect(parseCommand(JSON.stringify({ type: "rm -rf", householdId: "h1" }))).toBeNull();
    expect(parseCommand("not json")).toBeNull();
  });

  it("define os tipos processáveis", () => {
    expect(isProcessableType("TEXT", { hasText: true, hasMedia: false })).toBe(true);
    expect(isProcessableType("TEXT", { hasText: false, hasMedia: false })).toBe(false);
    expect(isProcessableType("AUDIO", { hasText: false, hasMedia: true })).toBe(true);
    expect(isProcessableType("DOCUMENT", { hasText: false, hasMedia: true, mimeType: "application/pdf" })).toBe(true);
    expect(isProcessableType("DOCUMENT", { hasText: false, hasMedia: true, mimeType: "application/zip" })).toBe(false);
    expect(isProcessableType("STICKER", { hasText: false, hasMedia: true })).toBe(false);
    expect(isProcessableType("REACTION", { hasText: true, hasMedia: false })).toBe(false);
  });
});

/**
 * Utilitários de telefone/JID sem dependência de provedor (usados também pelas rotas do Next.js).
 */

/** Normaliza para E.164 ("+5581999999999"). Retorna null se não houver dígitos suficientes. */
export function normalizeE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Variantes equivalentes de um número. No Brasil, contas antigas podem estar registradas no
 * WhatsApp sem o nono dígito (55 81 9xxxx-xxxx ↔ 55 81 xxxx-xxxx).
 */
export function phoneVariants(input: string | null | undefined): string[] {
  const e164 = normalizeE164(input);
  if (!e164) return [];
  const digits = e164.slice(1);
  const out = new Set<string>([e164]);
  if (digits.startsWith("55")) {
    const national = digits.slice(2);
    const ddd = national.slice(0, 2);
    const local = national.slice(2);
    if (local.length === 9 && local.startsWith("9")) out.add(`+55${ddd}${local.slice(1)}`);
    if (local.length === 8 && /^[6-9]/.test(local)) out.add(`+55${ddd}9${local}`);
  }
  return [...out];
}

export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const va = phoneVariants(a);
  const vb = new Set(phoneVariants(b));
  return va.some((v) => vb.has(v));
}

/** Parte "usuário" de um JID, sem dispositivo/agente: "5581...:12@s.whatsapp.net" → "5581...". */
export function jidUser(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  const user = at >= 0 ? jid.slice(0, at) : jid;
  return user.split(":")[0]!.split("_")[0] || null;
}

export function jidServer(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  return at >= 0 ? jid.slice(at + 1) : null;
}

export function isLidJid(jid: string | null | undefined): boolean {
  const s = jidServer(jid);
  return s === "lid" || s === "hosted.lid";
}

export function isPnJid(jid: string | null | undefined): boolean {
  const s = jidServer(jid);
  return s === "s.whatsapp.net" || s === "c.us" || s === "hosted";
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return jidServer(jid) === "g.us";
}

/** JID normalizado (sem dispositivo): "5581...@s.whatsapp.net" / "123@lid". */
export function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const user = jidUser(jid);
  const server = jidServer(jid);
  if (!user || !server) return null;
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

/** Telefone E.164 a partir de um JID por telefone. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!isPnJid(jid)) return null;
  return normalizeE164(jidUser(jid));
}

/** JID por telefone a partir de E.164. */
export function jidFromPhone(phone: string | null | undefined): string | null {
  const e164 = normalizeE164(phone);
  return e164 ? `${e164.slice(1)}@s.whatsapp.net` : null;
}

/** Mascara um número para exibição/log: +55 81 9****-**99. */
export function maskPhone(phone: string | null | undefined): string | null {
  const e164 = normalizeE164(phone);
  if (!e164) return null;
  return `${e164.slice(0, 5)}${"*".repeat(Math.max(0, e164.length - 7))}${e164.slice(-2)}`;
}

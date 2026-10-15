import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { env } from "./env";

// -----------------------------------------------------------------------------
// Criptografia simétrica (AES-256-GCM) para dados sensíveis em repouso:
// sessões do WhatsApp, chaves de API, transcrições e mídias.
// Formato: "v1:" + base64(iv[12] | tag[16] | ciphertext)
// -----------------------------------------------------------------------------

let keyCache: Buffer | null = null;

function encryptionKey(): Buffer {
  if (keyCache) return keyCache;
  const raw = env().ENCRYPTION_KEY;
  let key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    // Aceita chaves de outro tamanho derivando 32 bytes (documentado no .env.example).
    key = createHash("sha256").update(raw).digest();
  }
  keyCache = key;
  return key;
}

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptBuffer(payload: Buffer): Buffer {
  if (payload.length < 28) throw new Error("Payload criptografado inválido");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptString(plain: string): string {
  return `v1:${encryptBuffer(Buffer.from(plain, "utf8")).toString("base64")}`;
}

export function decryptString(payload: string): string {
  if (!payload.startsWith("v1:")) throw new Error("Formato de dado criptografado desconhecido");
  return decryptBuffer(Buffer.from(payload.slice(3), "base64")).toString("utf8");
}

export function decryptStringSafe(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decryptString(payload);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Hashes e tokens
// -----------------------------------------------------------------------------

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Hash de token de sessão/convite (armazenamos apenas o hash). */
export function hashToken(token: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(token).digest("hex");
}

// -----------------------------------------------------------------------------
// Senhas: scrypt (memory-hard), parâmetros recomendados pela OWASP.
// Formato: scrypt$N$r$p$salt$hash
// -----------------------------------------------------------------------------

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Validação de força mínima de senha. Retorna mensagem de erro ou null. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return "A senha deve ter pelo menos 10 caracteres.";
  if (password.length > 200) return "A senha é longa demais.";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return "Use ao menos três tipos de caracteres (minúsculas, maiúsculas, números, símbolos).";
  return null;
}

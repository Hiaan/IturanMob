import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { decryptBuffer, encryptBuffer, sha256Hex } from "../crypto";

/**
 * Armazenamento local de arquivos (mídias do WhatsApp, comprovantes, importações, relatórios).
 * O conteúdo é sempre criptografado em repouso (AES-256-GCM). As chaves de armazenamento são
 * relativas a STORAGE_DIR e nunca derivadas de dados do usuário (evita path traversal).
 */
function root(): string {
  return path.resolve(env().STORAGE_DIR);
}

function resolveKey(key: string): string {
  if (!/^[a-z0-9-]+\/[0-9]{4}\/[0-9]{2}\/[a-zA-Z0-9-]+\.bin$/.test(key)) throw new Error("Chave de armazenamento inválida");
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error("Chave de armazenamento inválida");
  return full;
}

export interface StoredFile {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/** Grava o conteúdo criptografado. `area` agrupa por tipo (ex.: "media", "imports", "reports"). */
export async function storeFile(area: "media" | "imports" | "reports" | "exports", content: Buffer): Promise<StoredFile> {
  const now = new Date();
  const key = `${area}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.bin`;
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, encryptBuffer(content), { mode: 0o600 });
  return { storageKey: key, sha256: sha256Hex(content), sizeBytes: content.length };
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  return decryptBuffer(await readFile(resolveKey(storageKey)));
}

export async function deleteStoredFile(storageKey: string): Promise<void> {
  await rm(resolveKey(storageKey), { force: true });
}

export async function storedFileExists(storageKey: string): Promise<boolean> {
  try {
    await stat(resolveKey(storageKey));
    return true;
  } catch {
    return false;
  }
}

"use client";

/**
 * Estado do lote com vários arquivos (envio sequencial + confirmação em conjunto).
 *
 * Fica fora da árvore React para sobreviver à navegação entre o lote e a revisão de cada arquivo
 * (?batch=<id>) e continuar enviando a fila mesmo se a tela for trocada. Uma cópia sem os arquivos
 * vai para o sessionStorage, para o lote reaparecer após recarregar a página.
 */
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { uploadImport, type UploadOptions } from "./use-imports";
import type { BulkCommitFileResult } from "./types";

export type BulkItemPhase = "queued" | "uploading" | "uploaded" | "error";

export interface BulkItem {
  key: string;
  name: string;
  size: number;
  phase: BulkItemPhase;
  batchId: string | null;
  error: string | null;
  /** Falhas de rede, limite de requisições ou erro do servidor podem ser reenviadas; arquivo inválido, não. */
  retryable?: boolean;
}

export interface BulkSession {
  id: string;
  createdAt: number;
  opts: UploadOptions;
  items: BulkItem[];
  /** Resultado da confirmação em conjunto, por lote (acumula se houver mais de uma confirmação). */
  results: Record<string, BulkCommitFileResult>;
}

const STORAGE_KEY = "fa:imports:bulk";
const INTERRUPTED = "Envio interrompido ao recarregar a página. Selecione o arquivo de novo em uma nova importação.";

const files = new Map<string, File>();
const listeners = new Set<() => void>();
let session: BulkSession | null = typeof window === "undefined" ? null : load();
let running = false;

function load(): BulkSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BulkSession;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    // Os arquivos não sobrevivem ao recarregamento: o que estava na fila não pode mais ser enviado.
    return {
      ...parsed,
      results: parsed.results ?? {},
      items: parsed.items.map((i) => (i.phase === "queued" || i.phase === "uploading" ? { ...i, phase: "error" as const, error: INTERRUPTED } : i)),
    };
  } catch {
    return null;
  }
}

function persist() {
  try {
    if (session) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // armazenamento indisponível (modo privado, cota): o lote continua só em memória
  }
}

function set(next: BulkSession | null) {
  session = next;
  persist();
  listeners.forEach((l) => l());
}

function patchItem(sessionId: string, key: string, patch: Partial<BulkItem>) {
  if (!session || session.id !== sessionId) return;
  set({ ...session, items: session.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
}

async function runQueue(qc: QueryClient) {
  if (running) return;
  running = true;
  let uploadedAny = false;
  try {
    for (;;) {
      const current = session;
      const next = current?.items.find((i) => i.phase === "queued");
      if (!current || !next) break;
      const file = files.get(next.key);
      if (!file) {
        patchItem(current.id, next.key, { phase: "error", error: "O arquivo não está mais disponível. Selecione-o de novo." });
        continue;
      }
      patchItem(current.id, next.key, { phase: "uploading", error: null });
      try {
        const preview = await uploadImport(file, current.opts);
        uploadedAny = true;
        qc.setQueryData(qk.imports({ batch: preview.batch.id }), preview);
        files.delete(next.key);
        patchItem(current.id, next.key, { phase: "uploaded", batchId: preview.batch.id, error: null });
      } catch (e) {
        const retryable = !(e instanceof ApiError) || e.status === 408 || e.status === 429 || e.status >= 500;
        patchItem(current.id, next.key, { phase: "error", error: errorMessage(e), retryable });
      }
    }
  } finally {
    running = false;
    if (uploadedAny) void qc.invalidateQueries({ queryKey: qk.imports({ list: true }) });
    announceDone();
    // Um novo lote pode ter sido criado enquanto o envio anterior terminava.
    if (session?.items.some((i) => i.phase === "queued")) void runQueue(qc);
  }
}

/** Aviso único ao fim da fila (o usuário pode estar revisando outro arquivo enquanto os demais sobem). */
function announceDone() {
  if (!session || isBulkUploading(session)) return;
  const done = session.items.filter((i) => i.phase === "uploaded").length;
  const failed = session.items.filter((i) => i.phase === "error").length;
  const description = `${done} de ${session.items.length} arquivo(s) com prévia pronta${failed ? ` · ${failed} com erro` : ""}. Revise o lote e confirme.`;
  if (failed) toast.warning("Envio do lote concluído com erros", { description });
  else toast.success("Arquivos lidos", { description });
}

function fileKey(file: File, index: number) {
  return `${index}-${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cria o lote e começa a enviar os arquivos, um por requisição. */
export function startBulkUpload(qc: QueryClient, list: File[], opts: UploadOptions) {
  files.clear();
  const items: BulkItem[] = list.map((file, i) => {
    const key = fileKey(file, i);
    files.set(key, file);
    return { key, name: file.name, size: file.size, phase: "queued", batchId: null, error: null };
  });
  set({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), opts, items, results: {} });
  void runQueue(qc);
}

/** Reenvia um arquivo que falhou (quando ele ainda está em memória). */
export function retryBulkItem(qc: QueryClient, key: string) {
  if (!session || !files.has(key)) return;
  patchItem(session.id, key, { phase: "queued", error: null });
  void runQueue(qc);
}

export function canRetryBulkItem(item: BulkItem) {
  return item.phase === "error" && item.retryable !== false && files.has(item.key);
}

/** Tira o arquivo do lote. A prévia já criada continua no histórico. */
export function removeBulkItem(key: string) {
  if (!session) return;
  const item = session.items.find((i) => i.key === key);
  if (!item || item.phase === "uploading") return;
  files.delete(key);
  set({ ...session, items: session.items.filter((i) => i.key !== key) });
}

export function recordBulkResults(results: BulkCommitFileResult[]) {
  if (!session) return;
  const merged = { ...session.results };
  for (const r of results) merged[r.batchId] = r;
  set({ ...session, results: merged });
}

export function clearBulkSession() {
  files.clear();
  set(null);
}

export function isBulkUploading(s: BulkSession | null) {
  return Boolean(s?.items.some((i) => i.phase === "queued" || i.phase === "uploading"));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBulkSession(): BulkSession | null {
  return useSyncExternalStore(
    subscribe,
    () => session,
    () => null,
  );
}

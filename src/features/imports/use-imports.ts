"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { BulkCommitResponse, ColumnMapping, ImportBatchDTO, ImportFormat, ImportPreview, Reconciliation, RowUpdate, RowsNatureInput, RowsNatureResult, RowsTransferInput, RowsTransferResult } from "./types";

/** Espelha IMPORT_MAX_BYTES do servidor (15 MB por arquivo). */
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
export const MAX_IMPORT_MB = MAX_IMPORT_BYTES / 1024 / 1024;
/** Limite de arquivos por lote (POST /api/v1/imports/bulk-commit aceita até 20). */
export const MAX_BULK_FILES = 20;

const FINANCE_KEYS = ["imports", "transactions", "accounts", "cards", "analytics", "pending", "budgets", "bills", "me"];

export function useInvalidateFinance() {
  const qc = useQueryClient();
  return () => FINANCE_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

export function useImportList() {
  return useQuery({ queryKey: qk.imports({ list: true }), queryFn: () => api.get<ImportBatchDTO[]>("/api/v1/imports", { limit: 50 }) });
}

export function useImportPreview(batchId: string | null) {
  return useQuery({ queryKey: qk.imports({ batch: batchId }), queryFn: () => api.get<ImportPreview>(`/api/v1/imports/${batchId}`), enabled: Boolean(batchId) });
}

/** Prévias de vários lotes (tela do lote com vários arquivos). Reaproveita o cache preenchido no envio. */
export function useImportPreviews(batchIds: string[]) {
  return useQueries({
    queries: batchIds.map((id) => ({ queryKey: qk.imports({ batch: id }), queryFn: () => api.get<ImportPreview>(`/api/v1/imports/${id}`) })),
  });
}

export function useReconciliation(batchId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.imports({ reconciliation: batchId }),
    queryFn: () => api.get<Reconciliation>(`/api/v1/imports/${batchId}/reconciliation`),
    enabled: Boolean(batchId) && enabled,
  });
}

export interface UploadOptions {
  accountId?: string | null;
  creditCardId?: string | null;
  format?: ImportFormat | null;
  invertSigns?: boolean;
}

/** Envio multipart (um arquivo por requisição, até 15 MB — acima do limite das requisições JSON). */
export async function uploadImport(file: File, opts: UploadOptions): Promise<ImportPreview> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("fileName", file.name);
  if (opts.accountId) form.append("accountId", opts.accountId);
  if (opts.creditCardId) form.append("creditCardId", opts.creditCardId);
  if (opts.format) form.append("format", opts.format);
  if (opts.invertSigns) form.append("invertSigns", "true");
  const res = await fetch("/api/v1/imports", {
    method: "POST",
    body: form,
    credentials: "same-origin",
    headers: { Accept: "application/json", "X-Requested-With": "fetch" },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new ApiError(401, "UNAUTHORIZED", "Sessão expirada.");
  }
  let payload: { data?: ImportPreview; error?: { code: string; message: string; details?: unknown } } = {};
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(res.status, "HTTP_ERROR", "Falha de comunicação com o servidor.");
  }
  if (!res.ok || payload.error || !payload.data) {
    throw new ApiError(res.status, payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? "Não foi possível ler o arquivo.", payload.error?.details);
  }
  return payload.data;
}

export function useUploadImport(onDone: (preview: ImportPreview) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, opts }: { file: File; opts: UploadOptions }) => uploadImport(file, opts),
    onSuccess: (preview) => {
      qc.setQueryData(qk.imports({ batch: preview.batch.id }), preview);
      qc.invalidateQueries({ queryKey: qk.imports({ list: true }) });
      toast.success("Arquivo lido", { description: `${preview.counts.total} linha(s) encontradas em ${preview.batch.fileName}.` });
      onDone(preview);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useUpdateRows(batchId: string) {
  const qc = useQueryClient();
  const key = qk.imports({ batch: batchId });
  return useMutation({
    mutationFn: (rows: RowUpdate[]) => api.patch<ImportPreview>(`/api/v1/imports/${batchId}/rows`, { rows }),
    onMutate: async (rows) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ImportPreview>(key);
      if (previous) {
        const byId = new Map(rows.map((r) => [r.rowId, r]));
        qc.setQueryData<ImportPreview>(key, {
          ...previous,
          rows: previous.rows.map((r) => {
            const u = byId.get(r.id);
            if (!u) return r;
            return {
              ...r,
              ...(u.selected !== undefined ? { selected: u.selected } : {}),
              ...(u.categoryId !== undefined ? { categoryId: u.categoryId } : {}),
              ...(u.forceNew ? { status: "NEW" as const, selected: true, matchedTransaction: null } : {}),
            };
          }),
        });
      }
      return { previous };
    },
    onSuccess: (data) => qc.setQueryData(key, data),
    onError: (e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toast.error(errorMessage(e));
    },
  });
}

/** Marca linhas da prévia como transferência entre contas próprias (ou desfaz, com transferAccountId null). */
export function useSetRowsTransfer(batchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rowIds, transferAccountId, applyToSimilar, remember, counterpartAmountCents }: RowsTransferInput & { accountName?: string | null }) =>
      api.post<RowsTransferResult>(`/api/v1/imports/${batchId}/transfer`, { rowIds, transferAccountId, applyToSimilar, remember, ...(counterpartAmountCents ? { counterpartAmountCents } : {}) }),
    onSuccess: (data, vars) => {
      const { updatedRows, ruleCreated, ...preview } = data;
      qc.setQueryData(qk.imports({ batch: batchId }), preview);
      if (ruleCreated) qc.invalidateQueries({ queryKey: qk.rules });
      if (!vars.transferAccountId) {
        toast.success(`${updatedRows} linha(s) voltaram para receita/despesa`, { description: "Escolha a categoria, se quiser, antes de confirmar." });
        return;
      }
      toast.success(`${updatedRows} linha(s) marcada(s) como transferência${vars.accountName ? ` com ${vars.accountName}` : ""}`, {
        description: ruleCreated
          ? "Regra criada: as próximas importações (e o WhatsApp) já tratam essas movimentações como transferência."
          : vars.remember
            ? "Já existia uma regra igual: nada novo foi criado."
            : "Não contam como receita nem despesa.",
      });
    },
  });
}

const NATURE_NAMES = { PERSONAL: "Pessoal", BUSINESS: "Empresa", PASSTHROUGH: "Repasse" } as const;

/** Natureza das linhas da prévia (vale sobre as regras ao importar; saldo e fatura não mudam). */
export function useSetRowsNature(batchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RowsNatureInput) => api.post<RowsNatureResult>(`/api/v1/imports/${batchId}/nature`, body),
    onSuccess: (data, vars) => {
      const { updatedRows, ...preview } = data;
      qc.setQueryData(qk.imports({ batch: batchId }), preview);
      const n = updatedRows;
      const rows = `${n} ${n === 1 ? "linha" : "linhas"}`;
      if (vars.nature === null) toast.success(`${rows}: natureza volta para a sugestão das regras`);
      else
        toast.success(`${rows} como ${NATURE_NAMES[vars.nature]}`, {
          description: `${vars.applyToSimilar && n > vars.rowIds.length ? "Inclui as parecidas deste arquivo. " : ""}Vale ao importar. Saldo e fatura não mudam.`,
        });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useRemap(batchId: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mapping?: ColumnMapping | null; headerRowIndex?: number | null; invertSigns?: boolean }) => api.post<ImportPreview>(`/api/v1/imports/${batchId}/mapping`, body),
    onSuccess: (data) => {
      qc.setQueryData(qk.imports({ batch: batchId }), data);
      qc.invalidateQueries({ queryKey: qk.imports({ list: true }) });
      toast.success("Prévia atualizada", { description: `${data.counts.NEW} lançamento(s) novo(s) identificados.` });
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useCommitImport(batchId: string, onDone?: (data: ImportPreview) => void) {
  const qc = useQueryClient();
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: () => api.post<ImportPreview>(`/api/v1/imports/${batchId}/commit`),
    onSuccess: (data) => {
      qc.setQueryData(qk.imports({ batch: batchId }), data);
      invalidate();
      const r = data.result ?? {};
      toast.success("Importação concluída", {
        description: `${r.created ?? 0} lançamento(s) criado(s) · ${r.matched ?? 0} correspondência(s) · ${r.divergent ?? 0} divergência(s)${r.errors ? ` · ${r.errors} com erro` : ""}.`,
      });
      onDone?.(data);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/**
 * Confirma vários lotes em PREVIEW de uma vez. O servidor grava um arquivo por vez e, antes de cada um,
 * confere de novo as duplicidades com o que os anteriores já criaram.
 */
export function useBulkCommit(onDone?: (data: BulkCommitResponse) => void) {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (batchIds: string[]) => api.post<BulkCommitResponse>("/api/v1/imports/bulk-commit", { batchIds }),
    onSuccess: (data) => {
      const t = data.totals;
      const ok = data.results.filter((r) => r.ok).length;
      const failed = data.results.length - ok;
      const description = `${t.created} lançamento(s) criado(s) em ${ok} arquivo(s) · ${t.duplicatesAtCommit} duplicado(s) evitado(s) na confirmação${t.errors ? ` · ${t.errors} linha(s) com erro` : ""}.`;
      if (failed) toast.warning(`${failed} de ${data.results.length} arquivo(s) não foram importados`, { description });
      else toast.success("Lote importado", { description });
      onDone?.(data);
    },
    onError: (e) => toast.error(errorMessage(e)),
    // Mesmo com falha no meio do caminho, parte dos arquivos pode ter sido gravada: recarrega tudo.
    onSettled: () => invalidate(),
  });
}

export function useUndoImport(onDone?: () => void) {
  const qc = useQueryClient();
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (batchId: string) => api.post<ImportPreview>(`/api/v1/imports/${batchId}/undo`),
    onSuccess: (data) => {
      qc.setQueryData(qk.imports({ batch: data.batch.id }), data);
      invalidate();
      toast.success("Importação desfeita", { description: `${data.result?.removed ?? 0} lançamento(s) enviados para a lixeira; saldos recalculados.` });
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

"use client";

import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { useInvalidateFinance } from "@/features/imports/use-imports";
import type {
  ColumnMap,
  CorrespondenceDecision,
  CorrespondenceField,
  MatrixMode,
  MigrationDTO,
  MigrationListItemDTO,
  MigrationOptionsDTO,
  MigrationStatus,
  MigrationTemplateDTO,
  UnsignedAs,
} from "@/server/modules/migration/types";

/** Espelha o limite do servidor (15 MB por planilha). */
export const MIGRATION_MAX_BYTES = 15 * 1024 * 1024;
export const MIGRATION_MAX_MB = MIGRATION_MAX_BYTES / 1024 / 1024;
/** Planilha modelo (.xlsx) para quem quer começar do zero ou copiar os dados para um formato conhecido. */
export const MIGRATION_MODEL_URL = "/api/v1/migrations/model";
/** Intervalo da consulta enquanto o servidor lê a planilha, gera a prévia ou grava. */
const POLL_MS = 1500;

export const migrationKeys = {
  list: ["migrations"] as const,
  templates: ["migrations", "templates"] as const,
  detail: (id: string) => ["migration", id] as const,
};

const BUSY: MigrationStatus[] = ["READING", "PREVIEWING", "COMMITTING"];

/** O servidor está trabalhando nesta migração (a tela consulta de novo a cada 1,5 s). */
export function isBusyStatus(status: MigrationStatus): boolean {
  return BUSY.includes(status);
}

export function useMigration(id: string | null) {
  return useQuery({
    queryKey: migrationKeys.detail(id ?? ""),
    queryFn: () => api.get<MigrationDTO>(`/api/v1/migrations/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data && isBusyStatus(query.state.data.status) ? POLL_MS : false),
  });
}

export function useMigrationList() {
  return useQuery({
    queryKey: migrationKeys.list,
    queryFn: () => api.get<MigrationListItemDTO[]>("/api/v1/migrations"),
    // Atualiza o progresso das que ainda estão sendo lidas/gravadas.
    refetchInterval: (query) => (query.state.data?.some((m) => isBusyStatus(m.status)) ? 4000 : false),
  });
}

export function useMigrationTemplates(enabled = true) {
  return useQuery({
    queryKey: migrationKeys.templates,
    queryFn: () => api.get<MigrationTemplateDTO[]>("/api/v1/migrations/templates"),
    enabled,
  });
}

/** Alguma ação desta migração em andamento (para desabilitar os botões enquanto isso). */
export function useMigrationBusy(id: string): boolean {
  return useIsMutating({ mutationKey: ["migration", id] }) > 0;
}

/** Envio multipart da planilha (até 15 MB — acima do limite das requisições JSON). */
export async function uploadMigration(file: File): Promise<MigrationDTO> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/v1/migrations", {
    method: "POST",
    body: form,
    credentials: "same-origin",
    headers: { Accept: "application/json", "X-Requested-With": "fetch" },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new ApiError(401, "UNAUTHORIZED", "Sessão expirada.");
  }
  let payload: { data?: MigrationDTO; error?: { code: string; message: string; details?: unknown } } = {};
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(res.status, "HTTP_ERROR", "Falha de comunicação com o servidor.");
  }
  if (!res.ok || payload.error || !payload.data) {
    throw new ApiError(res.status, payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? "Não foi possível ler a planilha.", payload.error?.details);
  }
  return payload.data;
}

function storeMigration(qc: QueryClient, dto: MigrationDTO) {
  qc.setQueryData(migrationKeys.detail(dto.id), dto);
  qc.invalidateQueries({ queryKey: migrationKeys.list, exact: true });
}

export function useUploadMigration(onDone: (dto: MigrationDTO) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadMigration(file),
    onSuccess: (dto) => {
      storeMigration(qc, dto);
      if (dto.status === "READY") toast.success("Planilha lida", { description: `${dto.sheets.length} aba(s) encontrada(s) em ${dto.fileName}.` });
      else if (dto.status === "FAILED") toast.error("Não foi possível ler a planilha", { description: dto.error ?? undefined });
      onDone(dto);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

type Feedback = string | { title: string; description?: string } | null;

/** Ação sobre uma migração: grava o DTO devolvido no cache (["migration", id]) e mostra o aviso. */
function useMigrationAction<V>(
  id: string,
  name: string,
  request: (vars: V) => Promise<MigrationDTO>,
  feedback?: (dto: MigrationDTO, vars: V, before: MigrationDTO | undefined) => Feedback,
  after?: (dto: MigrationDTO) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["migration", id, name],
    mutationFn: request,
    onSuccess: (dto, vars) => {
      const before = qc.getQueryData<MigrationDTO>(migrationKeys.detail(id));
      storeMigration(qc, dto);
      const msg = feedback?.(dto, vars, before);
      if (typeof msg === "string") toast.success(msg);
      else if (msg) toast.success(msg.title, { description: msg.description });
      after?.(dto);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export interface SheetPatch {
  index: number;
  selected?: boolean;
  kind?: "LIST" | "MONTH" | "MATRIX" | "SUMMARY";
  headerRowIndex?: number;
  columns?: Partial<ColumnMap>;
  month?: string | null;
  unsignedAs?: UnsignedAs;
  invertSigns?: boolean;
  matrixMode?: MatrixMode | null;
  /** Categorias × meses: ano do primeiro mês (quando o cabeçalho não traz o ano). */
  matrixYear?: number;
}

/** Ajustes das abas (as correspondências são recalculadas no servidor). Aplica na tela antes da resposta. */
export function useUpdateSheets(id: string) {
  const qc = useQueryClient();
  const key = migrationKeys.detail(id);
  return useMutation({
    mutationKey: ["migration", id, "sheets"],
    mutationFn: (sheets: SheetPatch[]) => api.patch<MigrationDTO>(`/api/v1/migrations/${id}/sheets`, { sheets }),
    onMutate: async (sheets) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MigrationDTO>(key);
      if (previous) {
        const byIndex = new Map(sheets.map((s) => [s.index, s]));
        qc.setQueryData<MigrationDTO>(key, {
          ...previous,
          sheets: previous.sheets.map((s) => {
            const p = byIndex.get(s.index);
            if (!p) return s;
            const { index: _index, columns, ...rest } = p;
            return { ...s, ...rest, columns: columns ? { ...s.columns, ...columns } : s.columns };
          }),
        });
      }
      return { previous };
    },
    onSuccess: (dto) => storeMigration(qc, dto),
    onError: (e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toast.error(errorMessage(e));
    },
  });
}

export interface CorrespondenceUpdate {
  field: CorrespondenceField;
  key: string;
  decision: CorrespondenceDecision | null;
}

/** Decisões "De → Para" (aceitar, escolher outra, criar, ignorar ou desfazer). Aplica na tela antes da resposta. */
export function useUpdateCorrespondences(id: string) {
  const qc = useQueryClient();
  const key = migrationKeys.detail(id);
  return useMutation({
    mutationKey: ["migration", id, "correspondences"],
    mutationFn: (items: CorrespondenceUpdate[]) => api.patch<MigrationDTO>(`/api/v1/migrations/${id}/correspondences`, { items }),
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MigrationDTO>(key);
      if (previous) {
        const byKey = new Map(items.map((i) => [`${i.field}\u0000${i.key}`, i.decision]));
        qc.setQueryData<MigrationDTO>(key, {
          ...previous,
          correspondences: previous.correspondences.map((c) => {
            const k = `${c.field}\u0000${c.key}`;
            return byKey.has(k) ? { ...c, decision: byKey.get(k) ?? null } : c;
          }),
        });
      }
      return { previous };
    },
    onSuccess: (dto) => storeMigration(qc, dto),
    onError: (e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toast.error(errorMessage(e));
    },
  });
}

const totalPending = (m: MigrationDTO | undefined) => (m ? Object.values(m.pending).reduce((s, n) => s + n, 0) : 0);

export function useApplySuggestions(id: string) {
  return useMigrationAction<CorrespondenceField[] | undefined>(
    id,
    "apply-suggestions",
    (fields) => api.post<MigrationDTO>(`/api/v1/migrations/${id}/correspondences/apply-suggestions`, fields?.length ? { fields } : {}),
    (dto, _fields, before) => {
      const solved = Math.max(0, totalPending(before) - totalPending(dto));
      return solved ? { title: `${solved} sugestão(ões) aceita(s)`, description: "Confira e troque o que quiser antes de gerar a prévia." } : "Não havia sugestões pendentes.";
    },
  );
}

export function useSuggestWithAI(id: string) {
  return useMigrationAction<void>(
    id,
    "ai",
    () => api.post<MigrationDTO>(`/api/v1/migrations/${id}/correspondences/ai`),
    (dto, _v, before) => {
      const count = (m: MigrationDTO | undefined) => m?.correspondences.filter((c) => c.suggestion?.source === "AI").length ?? 0;
      const added = Math.max(0, count(dto) - count(before));
      return added
        ? { title: `A IA sugeriu ${added} correspondência(s)`, description: "Elas aparecem com a etiqueta “IA”: aceite, troque ou ignore." }
        : { title: "A IA não encontrou sugestões novas", description: "Escolha, crie ou ignore os itens que faltam." };
    },
  );
}

export interface DestinationInput {
  field: "account" | "card";
  key: string;
  kind: "ACCOUNT" | "CARD";
  name: string;
  accountType?: "CHECKING" | "SAVINGS" | "WALLET" | "INVESTMENT" | "DIGITAL" | "OTHER";
  institution?: string | null;
  closingDay?: number;
  dueDay?: number;
}

/** Cria a conta ou o cartão na hora e liga o item da planilha a ele. */
export function useCreateDestination(id: string) {
  const qc = useQueryClient();
  return useMigrationAction<DestinationInput>(
    id,
    "destinations",
    (body) => api.post<MigrationDTO>(`/api/v1/migrations/${id}/destinations`, body),
    (_dto, v) => ({ title: v.kind === "CARD" ? `Cartão “${v.name}” criado` : `Conta “${v.name}” criada`, description: "Já ficou ligado ao item da planilha." }),
    () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cards"] });
    },
  );
}

export function useUpdateOptions(id: string) {
  return useMigrationAction<Partial<MigrationOptionsDTO>>(id, "options", (body) => api.patch<MigrationDTO>(`/api/v1/migrations/${id}/options`, body));
}

/** Gera a prévia (status PREVIEWING; a tela acompanha até PREVIEW). */
export function useGeneratePreview(id: string) {
  return useMigrationAction<void>(id, "preview", () => api.post<MigrationDTO>(`/api/v1/migrations/${id}/preview`));
}

/** Volta da prévia para ajustar abas e correspondências (a prévia é descartada). */
export function useBackToEdit(id: string, onDone?: (dto: MigrationDTO) => void) {
  return useMigrationAction<void>(
    id,
    "back",
    () => api.post<MigrationDTO>(`/api/v1/migrations/${id}/back`),
    () => ({ title: "Prévia descartada", description: "Ajuste o que precisar e gere a prévia de novo." }),
    onDone,
  );
}

/** Importa a migração inteira (status COMMITTING; a tela acompanha até IMPORTED). */
export function useCommitMigration(id: string) {
  return useMigrationAction<void>(id, "commit", () => api.post<MigrationDTO>(`/api/v1/migrations/${id}/commit`));
}

/** Recarrega tudo o que a migração pode ter mudado (lançamentos, saldos, categorias, orçamentos, contas a pagar…). */
export function useInvalidateMigrationFinance() {
  const qc = useQueryClient();
  const invalidateFinance = useInvalidateFinance();
  return () => {
    invalidateFinance();
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: migrationKeys.list });
  };
}

export function useUndoMigration(id: string) {
  const invalidate = useInvalidateMigrationFinance();
  return useMigrationAction<void>(
    id,
    "undo",
    () => api.post<MigrationDTO>(`/api/v1/migrations/${id}/undo`),
    () => ({ title: "Migração desfeita", description: "Lançamentos enviados para a lixeira; saldos, orçamentos e contas a pagar voltaram ao que eram." }),
    () => invalidate(),
  );
}

export function useDiscardMigration(id: string) {
  return useMigrationAction<void>(
    id,
    "discard",
    () => api.post<MigrationDTO>(`/api/v1/migrations/${id}/discard`),
    () => ({ title: "Migração descartada", description: "Nenhum lançamento foi gravado." }),
  );
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (template: MigrationTemplateDTO) => api.delete<void>(`/api/v1/migrations/templates/${template.id}`),
    onSuccess: (_r, template) => {
      qc.setQueryData<MigrationTemplateDTO[]>(migrationKeys.templates, (list) => list?.filter((t) => t.id !== template.id));
      qc.invalidateQueries({ queryKey: migrationKeys.templates });
      toast.success(`Formato “${template.name}” excluído`, { description: "As próximas planilhas com esse formato serão interpretadas do zero." });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

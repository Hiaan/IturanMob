"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, downloadFile, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { GenerateReportInput, ReportListItem, ReportScheduleDTO, ReportView } from "./types";

export function useReportList() {
  return useQuery({ queryKey: qk.reports({ list: true }), queryFn: () => api.get<ReportListItem[]>("/api/v1/reports", { limit: 100 }) });
}

export function useReport(id: string | null) {
  return useQuery({
    queryKey: qk.reports({ id }),
    queryFn: () => api.get<ReportView>(`/api/v1/reports/${id}`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useGenerateReport(onDone: (report: ReportView) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateReportInput) => api.post<ReportView>("/api/v1/reports", input),
    onSuccess: (report) => {
      qc.setQueryData(qk.reports({ id: report.id }), report);
      qc.invalidateQueries({ queryKey: qk.reports({ list: true }) });
      toast.success("Relatório gerado", { description: report.data.periodLabel });
      onDone(report);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useReportSchedules() {
  return useQuery({ queryKey: qk.reports({ schedules: true }), queryFn: () => api.get<ReportScheduleDTO[]>("/api/v1/reports/schedules") });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, patch }: { type: "WEEKLY" | "MONTHLY"; patch: Partial<Omit<ReportScheduleDTO, "id" | "type" | "lastRunAt" | "nextRunAt">> }) =>
      api.patch<ReportScheduleDTO>(`/api/v1/reports/schedules/${type.toLowerCase()}`, patch),
    onMutate: async ({ type, patch }) => {
      const key = qk.reports({ schedules: true });
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ReportScheduleDTO[]>(key);
      qc.setQueryData<ReportScheduleDTO[]>(key, (list) => list?.map((s) => (s.type === type ? { ...s, ...patch } : s)));
      return { previous };
    },
    onSuccess: (updated) => {
      qc.setQueryData<ReportScheduleDTO[]>(qk.reports({ schedules: true }), (list) => list?.map((s) => (s.type === updated.type ? updated : s)));
      toast.success("Agendamento atualizado");
    },
    onError: (e, _vars, context) => {
      if (context?.previous) qc.setQueryData(qk.reports({ schedules: true }), context.previous);
      toast.error(errorMessage(e));
    },
  });
}

/** Baixa um arquivo e mostra o resultado em toast. */
export async function downloadWithToast(path: string, params: Record<string, unknown> | undefined, fallbackName: string, label: string) {
  try {
    await downloadFile(path, params, fallbackName);
    toast.success(`${label} gerado`, { description: "O download foi iniciado." });
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

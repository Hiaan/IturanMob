"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";

export interface HouseholdSettingsDTO {
  householdId: string;
  defaultRegime: "ACCRUAL" | "CASH";
  confidenceHigh: number;
  confidenceMedium: number;
  budgetAlertThresholds: number[];
  mediaRetentionDays: number;
  transcriptRetentionDays: number;
  aiExternalAllowed: boolean;
  aiAudioAllowed: boolean;
  aiImageAllowed: boolean;
  duplicateWindowHours: number;
  whatsappReplies: boolean;
  whatsappAnswerQueries: boolean;
  /** Recorte padrão do painel, relatórios, orçamentos e assistente (Repasse fica sempre de fora). */
  defaultReportScope: "PERSONAL" | "BUSINESS" | "ALL";
}

export interface HouseholdDTO {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  locale: string;
  settings: HouseholdSettingsDTO;
}

export function useHousehold() {
  return useQuery({ queryKey: qk.household, queryFn: () => api.get<HouseholdDTO>("/api/v1/household") });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<HouseholdSettingsDTO>) => api.patch<HouseholdSettingsDTO>("/api/v1/household/settings", patch),
    onSuccess: () => {
      toast.success("Configurações salvas");
      qc.invalidateQueries({ queryKey: qk.household });
      qc.invalidateQueries({ queryKey: ["analytics"] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
      qc.invalidateQueries({ queryKey: ["ai"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

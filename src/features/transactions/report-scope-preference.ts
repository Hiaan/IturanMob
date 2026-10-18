"use client";

import { useSyncExternalStore } from "react";
import type { ReportScope } from "@/features/finance/types";
import { useHydrated } from "@/features/me/use-me";
import { useHousehold } from "@/features/settings/use-household";
import { REPORT_SCOPES } from "./nature";

/**
 * Recorte escolhido na barra "Pessoa física | Empresa | Tudo" (Painel, Lançamentos, Relatórios e
 * Gastos fixos). Fica lembrado neste navegador; sem escolha, vale o padrão da família.
 * Todas as páginas (e abas) leem a mesma preferência e ficam em sincronia.
 */
export const REPORT_SCOPE_STORAGE_KEY = "fa:report-scope";

export function isReportScope(v: unknown): v is ReportScope {
  return typeof v === "string" && (REPORT_SCOPES as string[]).includes(v);
}

/** Valor em memória: continua funcionando nesta sessão mesmo sem acesso ao armazenamento. */
let memory: ReportScope | null | undefined;
const listeners = new Set<() => void>();

function readStorage(): ReportScope | null {
  try {
    const v = window.localStorage.getItem(REPORT_SCOPE_STORAGE_KEY);
    return isReportScope(v) ? v : null;
  } catch {
    return null;
  }
}

function getSnapshot(): ReportScope | null {
  if (memory === undefined) memory = readStorage();
  return memory;
}

function getServerSnapshot(): ReportScope | null {
  return null;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Outra aba mudou a preferência (ou limpou o armazenamento).
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== REPORT_SCOPE_STORAGE_KEY) return;
    memory = readStorage();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Grava a escolha (null = voltar a seguir o padrão da família) e avisa todas as telas abertas. */
export function writeReportScopePreference(scope: ReportScope | null) {
  memory = scope;
  try {
    if (scope) window.localStorage.setItem(REPORT_SCOPE_STORAGE_KEY, scope);
    else window.localStorage.removeItem(REPORT_SCOPE_STORAGE_KEY);
  } catch {
    // armazenamento indisponível: fica só em memória nesta sessão
  }
  for (const l of listeners) l();
}

const setScope = (s: ReportScope) => writeReportScopePreference(s);
const followFamilyDefault = () => writeReportScopePreference(null);

export interface ReportScopePreference {
  /** Recorte em uso (null enquanto o padrão da família ainda não carregou). */
  scope: ReportScope | null;
  /** Padrão da família (Configurações › Família). */
  familyDefault: ReportScope | null;
  /** A pessoa escolheu um recorte neste navegador (senão, segue o padrão da família). */
  remembered: boolean;
  /** Já dá para consultar: recorte conhecido (ou o padrão falhou e o servidor aplica o dele). */
  ready: boolean;
  setScope: (s: ReportScope) => void;
  followFamilyDefault: () => void;
}

export function useReportScopePreference(): ReportScopePreference {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const hydrated = useHydrated();
  const household = useHousehold();
  // Durante a hidratação, igual ao HTML do servidor (sem dados da família).
  const familyDefault = hydrated ? (household.data?.settings.defaultReportScope ?? null) : null;
  const scope = stored ?? familyDefault;
  return {
    scope,
    familyDefault,
    remembered: stored !== null,
    ready: scope !== null || (hydrated && household.isError),
    setScope,
    followFamilyDefault,
  };
}

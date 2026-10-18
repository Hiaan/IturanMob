"use client";

import { Briefcase, Info, Layers, User, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ReportScope } from "@/features/finance/types";
import { REPORT_SCOPES, REPORT_SCOPE_HINTS, REPORT_SCOPE_LABELS, REPORT_SCOPE_PASSTHROUGH_NOTE } from "./nature";
import { useReportScopePreference } from "./report-scope-preference";

export const REPORT_SCOPE_ICONS: Record<ReportScope, LucideIcon> = { PERSONAL: User, BUSINESS: Briefcase, ALL: Layers };

/** O recorte não vale agora na página (ex.: só os desconsiderados, lixeira). */
export interface ScopeBarSuspension {
  text: string;
  resumeLabel: string;
  onResume: () => void;
}

/**
 * Barra fixa "Pessoa física | Empresa | Tudo" no topo do conteúdo (Painel, Lançamentos, Relatórios e
 * Gastos fixos). A escolha fica lembrada neste navegador e vale para todas essas páginas.
 */
export function ScopeBar({ note, suspended, className }: { note?: string; suspended?: ScopeBarSuspension | null; className?: string }) {
  const { scope, familyDefault, setScope, followFamilyDefault } = useReportScopePreference();
  const offDefault = Boolean(scope && familyDefault && scope !== familyDefault);
  const pick = (s: ReportScope) => {
    setScope(s);
    suspended?.onResume();
  };

  return (
    <div
      role="region"
      aria-label="Recorte da página"
      className={cn(
        "sticky top-[calc(4rem+var(--safe-top))] z-20 -mx-4 -mt-6 mb-6 border-b bg-background/90 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8",
        className,
      )}
    >
      <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-4">
        <div role="radiogroup" aria-label="Recorte: Pessoa física, Empresa ou Tudo" className="grid w-full shrink-0 grid-cols-[auto_auto_auto] gap-1 rounded-xl bg-muted p-1 md:w-auto md:min-w-[420px]">
          {REPORT_SCOPES.map((s) => {
            const Icon = REPORT_SCOPE_ICONS[s];
            const checked = !suspended && scope === s;
            const isDefault = familyDefault === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => pick(s)}
                title={`${REPORT_SCOPE_HINTS[s]}${isDefault ? " (padrão da família)" : ""}`}
                className={cn(
                  "relative flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:px-2.5 sm:text-sm",
                  checked ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", checked && (s === "BUSINESS" ? "text-series-7" : "text-brand"))} aria-hidden />
                <span className="truncate">{REPORT_SCOPE_LABELS[s]}</span>
                {isDefault && (
                  <>
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -top-2 right-1 rounded-full border border-brand/30 bg-accent px-1.5 text-[10px] leading-4 font-semibold text-accent-foreground"
                    >
                      padrão
                    </span>
                    <span className="sr-only"> (padrão da família)</span>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <p className="line-clamp-2 min-w-0 flex-1 md:line-clamp-none" aria-live="polite">
            {suspended ? (
              <>
                <span className="font-medium text-warning">{suspended.text}</span>{" "}
                <button type="button" onClick={suspended.onResume} className="font-medium text-brand hover:underline">
                  {suspended.resumeLabel}
                </button>
              </>
            ) : scope ? (
              <>
                {REPORT_SCOPE_HINTS[scope]}
                {note ? ` ${note}` : ""}
                {offDefault && familyDefault && (
                  <>
                    {" "}
                    · Padrão da família: {REPORT_SCOPE_LABELS[familyDefault]}.{" "}
                    <button type="button" onClick={followFamilyDefault} className="font-medium text-brand hover:underline">
                      Voltar ao padrão
                    </button>
                  </>
                )}
              </>
            ) : (
              "Carregando o recorte…"
            )}
          </p>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground" aria-label="Sobre o recorte Pessoa física, Empresa ou Tudo">
                <Info className="size-3.5" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-xs">
              <p className="text-sm font-semibold">Recorte</p>
              <ul className="space-y-1">
                {REPORT_SCOPES.map((s) => (
                  <li key={s}>
                    <strong className="font-medium text-foreground">{REPORT_SCOPE_LABELS[s]}</strong>
                    {familyDefault === s ? " (padrão da família)" : ""}: <span className="text-muted-foreground">{REPORT_SCOPE_HINTS[s]}</span>
                  </li>
                ))}
              </ul>
              {note && <p className="text-muted-foreground">{note}</p>}
              <p className="text-muted-foreground">{REPORT_SCOPE_PASSTHROUGH_NOTE} Saldo, faturas e contas a pagar não mudam com o recorte.</p>
              <p className="text-muted-foreground">A escolha fica lembrada neste navegador e vale para Painel, Lançamentos, Relatórios e Gastos fixos.</p>
              {offDefault && familyDefault && (
                <Button size="sm" variant="outline" className="w-full" onClick={followFamilyDefault}>
                  Voltar ao padrão da família ({REPORT_SCOPE_LABELS[familyDefault]})
                </Button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

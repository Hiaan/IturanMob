"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addMonthsToKey, formatMonthBR, monthKey, todayISO } from "@/lib/dates";
import { cn } from "@/lib/utils";

/** Seletor de mês (anterior/próximo), com atalho para o mês atual. */
export function MonthSwitcher({ month, onChange, timezone, className }: { month: string; onChange: (month: string) => void; timezone?: string; className?: string }) {
  const current = monthKey(todayISO(timezone));
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-lg border bg-card p-1 shadow-xs", className)} role="group" aria-label="Selecionar mês">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Mês anterior" onClick={() => onChange(addMonthsToKey(month, -1))}>
        <ChevronLeft />
      </Button>
      <span className="min-w-32 px-1 text-center text-sm font-medium" aria-live="polite">
        {formatMonthBR(month, { capitalize: true })}
      </span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Próximo mês" onClick={() => onChange(addMonthsToKey(month, 1))}>
        <ChevronRight />
      </Button>
      {month !== current && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(current)}>
          Atual
        </Button>
      )}
    </div>
  );
}

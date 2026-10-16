"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepDef {
  id: string;
  label: string;
}

/** Indicador das etapas da importação. */
export function Stepper({ steps, current, label = "Etapas da importação" }: { steps: StepDef[]; current: string; label?: string }) {
  const idx = steps.findIndex((s) => s.id === current);
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-2" aria-label={label}>
      {steps.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={s.id} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs font-semibold",
                done && "border-brand bg-brand text-brand-foreground",
                active && "border-brand text-brand",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-sm", active ? "font-semibold" : "text-muted-foreground")}>{s.label}</span>
            {i < steps.length - 1 && <span className="mx-1 hidden h-px w-8 bg-border sm:block" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

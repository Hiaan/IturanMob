"use client";

import { Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { isStrongWarning } from "./helpers";

/** Avisos da leitura do arquivo (mapeamento, arquivo repetido, sinais deduzidos, leitura por IA…). */
export function Warnings({ warnings, compact = false, className }: { warnings: string[]; compact?: boolean; className?: string }) {
  if (!warnings.length) return null;
  return (
    <div role={compact ? undefined : "status"} className={className}>
      <ul className={compact ? "space-y-1.5" : "space-y-2"} aria-label="Avisos">
      {warnings.map((w) => {
        const strong = isStrongWarning(w);
        return (
          <li
            key={w}
            className={cn("flex gap-2 rounded-lg border", compact ? "px-2.5 py-1.5 text-xs" : "p-3 text-sm", strong ? "border-warning/30 bg-warning/5" : "bg-muted/40")}
          >
            {strong ? (
              <TriangleAlert className={cn("shrink-0 text-warning", compact ? "mt-px size-3.5" : "mt-0.5 size-4")} aria-label="Atenção" />
            ) : (
              <Info className={cn("shrink-0 text-muted-foreground", compact ? "mt-px size-3.5" : "mt-0.5 size-4")} aria-hidden />
            )}
            <p className="min-w-0 break-words">{w}</p>
          </li>
        );
      })}
      </ul>
    </div>
  );
}

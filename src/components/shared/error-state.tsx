"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/client/api";

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={`flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 text-center ${compact ? "p-4" : "p-8"}`}>
      <TriangleAlert className="size-6 text-destructive" />
      <p className="max-w-full break-words text-sm text-destructive">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw /> Tentar novamente
        </Button>
      )}
    </div>
  );
}

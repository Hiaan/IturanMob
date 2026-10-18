"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Mic, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateBR } from "@/lib/dates";
import { useCan } from "@/features/me/use-me";

interface TranscriptFix {
  id: string;
  wrong: string;
  right: string;
  createdAt: string;
}

/**
 * Palavras que o áudio ouviu errado e a família corrigiu ("revirante" → "refrigerante"). Os próximos
 * áudios já saem certos; remover desfaz o aprendizado.
 */
export function TranscriptFixesCard() {
  const qc = useQueryClient();
  const canEdit = useCan("transactions:write");
  const fixes = useQuery({ queryKey: qk.ai({ transcriptFixes: true }), queryFn: () => api.get<TranscriptFix[]>("/api/v1/ai/transcript-fixes") });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/ai/transcript-fixes/${id}`),
    onSuccess: () => {
      toast.success("Correção removida");
      qc.invalidateQueries({ queryKey: qk.ai({ transcriptFixes: true }) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="size-4 text-brand" aria-hidden /> Correções do áudio
        </CardTitle>
        <CardDescription>
          Quando alguém corrige o nome de um lançamento feito por áudio (no WhatsApp: “é refrigerante”, ou editando aqui), a palavra fica guardada e os próximos áudios já saem
          certos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {fixes.isLoading ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : !fixes.data?.length ? (
          <p className="text-sm text-muted-foreground">Nenhuma correção ainda.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {fixes.data.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground line-through">{f.wrong}</span>
                  <ArrowRight className="mx-2 inline size-3.5 text-muted-foreground" aria-label="vira" />
                  <span className="font-medium">{f.right}</span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{formatDateBR(f.createdAt.slice(0, 10))}</span>
                {canEdit && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remover a correção ${f.wrong} → ${f.right}`}
                    loading={remove.isPending && remove.variables === f.id}
                    onClick={() => remove.mutate(f.id)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MonitorSmartphone } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";

interface PopupPreference {
  inAppPopups: boolean;
}

/** "Mostrar pop-ups no app" do membro logado (padrão ligado). */
export function usePopupPreference() {
  return useQuery({
    queryKey: qk.notificationPopups,
    queryFn: () => api.get<PopupPreference>("/api/v1/notifications/popups"),
    staleTime: 5 * 60_000,
  });
}

/** Alterna os pop-ups no app; salva na hora (independe do botão de salvar das preferências por tipo). */
export function InAppPopupsToggle() {
  const qc = useQueryClient();
  const q = usePopupPreference();
  // Estado local sincronizado com a consulta (como o formulário de preferências ao lado): o valor da
  // consulta compartilhada com os pop-ups às vezes não chegava à tela nesta aba (build de produção).
  const [checked, setChecked] = useState<boolean | null>(null);
  useEffect(() => {
    if (q.data) setChecked(q.data.inAppPopups);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (inAppPopups: boolean) => api.put<PopupPreference>("/api/v1/notifications/popups", { inAppPopups }),
    onMutate: (inAppPopups) => setChecked(inAppPopups),
    onSuccess: (data) => {
      qc.setQueryData(qk.notificationPopups, data);
      setChecked(data.inAppPopups);
      toast.success(data.inAppPopups ? "Pop-ups no app ligados" : "Pop-ups no app desligados");
    },
    onError: (err) => {
      setChecked(q.data?.inAppPopups ?? null);
      toast.error(errorMessage(err));
    },
  });

  return (
    <label className="flex items-start justify-between gap-3 rounded-xl border p-3 text-sm">
      <span className="flex min-w-0 items-start gap-2">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block font-medium">Mostrar pop-ups no app</span>
          <span className="block text-xs text-muted-foreground">
            Com o app aberto, avisos novos aparecem na tela. Ao voltar depois de um tempo, até 3 dos mais importantes. Vale só para você.
          </span>
        </span>
      </span>
      <Switch checked={checked ?? false} disabled={checked === null || save.isPending} onCheckedChange={(v) => save.mutate(v)} aria-label="Mostrar pop-ups no app" />
    </label>
  );
}

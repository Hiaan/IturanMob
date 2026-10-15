"use client";

import { useEffect, useState } from "react";
import { QrCode, Smartphone, Timer } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { useWhatsAppQr } from "./hooks";

/** QR Code para conectar o Baileys (atualiza a cada ~5 s; o WhatsApp renova o código periodicamente). */
export function QrPanel({ canManage }: { canManage: boolean }) {
  const qr = useWhatsAppQr(canManage);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!qr.data) {
      setRemaining(null);
      return;
    }
    const expiresAt = qr.dataUpdatedAt + qr.data.expiresInSeconds * 1000;
    const tick = () => setRemaining(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [qr.data, qr.dataUpdatedAt]);

  return (
    <Card className="overflow-hidden border-warning/40">
      <div className="grid gap-6 p-5 md:grid-cols-[auto_1fr] md:items-center">
        <div className="mx-auto flex flex-col items-center gap-2">
          <div className="flex size-64 items-center justify-center rounded-2xl border bg-white p-3 shadow-sm">
            {!canManage ? (
              <p className="px-4 text-center text-sm text-[#5a6a82]">Somente quem administra as integrações pode ver o QR Code.</p>
            ) : qr.isLoading || (qr.data === null && !qr.isError) ? (
              <div className="flex flex-col items-center gap-3 text-[#5a6a82]">
                <Skeleton className="size-44 bg-[#eef2f7]" />
                <span className="text-xs">Gerando QR Code…</span>
              </div>
            ) : qr.isError ? (
              <ErrorState error={qr.error} compact onRetry={() => qr.refetch()} />
            ) : qr.data ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.data.dataUrl} alt="QR Code para conectar o WhatsApp" className="size-full" />
            ) : null}
          </div>
          {remaining !== null && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <Timer className="size-3.5" aria-hidden />
              {remaining > 0 ? `Expira em ${remaining} s — um novo código aparece automaticamente` : "Atualizando o código…"}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <p className="flex items-center gap-2 text-lg font-semibold">
            <QrCode className="size-5 text-warning" aria-hidden /> Leia o QR Code com o celular
          </p>
          <ol className="space-y-2 text-sm">
            {[
              "Abra o WhatsApp no celular do número dedicado.",
              "Toque em Configurações (iPhone) ou ⋮ Mais opções (Android) › Aparelhos conectados.",
              "Toque em Conectar aparelho e aponte a câmera para este QR Code.",
              "Aguarde: o status muda para “Conectado” e os grupos são sincronizados.",
            ].map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">{i + 1}</span>
                <span className="pt-0.5 text-foreground/85">{step}</span>
              </li>
            ))}
          </ol>
          <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden />
            O aparelho aparecerá como “Finance AI” na lista de aparelhos conectados. Você pode removê-lo a qualquer momento por lá ou pelo botão “Encerrar sessão”.
          </p>
        </div>
      </div>
    </Card>
  );
}

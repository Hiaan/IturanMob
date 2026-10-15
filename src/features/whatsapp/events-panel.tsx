"use client";

import { History, Info } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { EVENT_META, TONE_SOFT_BG } from "./status-meta";
import type { WaStatus } from "./types";

export function EventsPanel({ status, timezone }: { status: WaStatus; timezone?: string }) {
  const events = status.recentEvents;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Histórico da conexão</CardTitle>
        <CardDescription>Conexões, quedas, QR Codes e erros recentes (sem conteúdo de mensagens).</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
            <History className="size-4" aria-hidden /> Nenhum evento registrado ainda.
          </p>
        ) : (
          <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border">
            {events.map((e) => {
              const meta = EVENT_META[e.type] ?? { label: e.type, tone: "muted" as const, icon: Info };
              const Icon = meta.icon;
              return (
                <li key={e.id} className="relative flex gap-3">
                  <span className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card", TONE_SOFT_BG[meta.tone])}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm font-medium">
                      {meta.label} <span className="font-normal text-muted-foreground">· {formatDateTimeBR(e.createdAt, timezone)}</span>
                    </p>
                    {e.message && <p className="break-words text-xs text-muted-foreground">{e.message}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

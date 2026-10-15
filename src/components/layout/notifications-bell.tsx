"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsBell() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: qk.notifications({ limit: 15 }),
    queryFn: () => api.get<{ items: NotificationItem[] }>("/api/v1/notifications", { limit: 15 }),
    refetchInterval: 120_000,
    retry: false,
  });
  const unread = (list.data?.items ?? []).filter((n) => !n.readAt).length;
  const readAll = useMutation({
    mutationFn: () => api.post("/api/v1/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const readOne = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notificações${unread ? ` (${unread} não lidas)` : ""}`}>
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute right-2 top-2 size-2 rounded-full bg-brand ring-2 ring-card" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Notificações</p>
          <Button variant="ghost" size="sm" onClick={() => readAll.mutate()} disabled={!unread} loading={readAll.isPending}>
            <CheckCheck /> Marcar todas
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {list.isError ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Não foi possível carregar as notificações.</p>
          ) : !list.data?.items.length ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma notificação por aqui.</p>
          ) : (
            <ul className="divide-y">
              {list.data.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => !n.readAt && readOne.mutate(n.id)}
                    className={cn("w-full px-4 py-3 text-left transition hover:bg-muted/50", !n.readAt && "bg-accent/40")}
                  >
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {!n.readAt && <span className="size-1.5 rounded-full bg-brand" aria-label="Não lida" />}
                      {n.title}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{formatDateTimeBR(n.createdAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t px-4 py-2 text-right">
          <Link href="/configuracoes?tab=notificacoes" className="text-xs font-medium text-brand hover:underline">
            Preferências de notificação
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

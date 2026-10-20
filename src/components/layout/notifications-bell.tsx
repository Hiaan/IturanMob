"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { NotificationIcon } from "@/features/notifications/notification-icon";
import type { NotificationPage } from "@/features/notifications/types";
import { OPEN_BELL_EVENT, useMarkAllNotificationsRead, useOpenNotification } from "@/features/notifications/use-notifications";

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: qk.notifications({ limit: 15 }),
    queryFn: () => api.get<NotificationPage>("/api/v1/notifications", { limit: 15 }),
    refetchInterval: 120_000,
    retry: false,
  });
  const unread = list.data?.unreadCount ?? (list.data?.items ?? []).filter((n) => !n.readAt).length;
  const readAll = useMarkAllNotificationsRead();
  const openNotification = useOpenNotification();

  // "Ver todas" dos pop-ups abre este painel.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_BELL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BELL_EVENT, onOpen);
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notificações${unread ? ` (${unread} não lidas)` : ""}`}>
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute right-2 top-2 size-2 rounded-full bg-brand ring-2 ring-card" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0" aria-label="Notificações">
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
                    onClick={() => {
                      setOpen(false);
                      openNotification(n);
                    }}
                    className={cn("flex w-full gap-3 px-4 py-3 text-left transition hover:bg-muted/50", !n.readAt && "bg-accent/40")}
                  >
                    <NotificationIcon type={n.type} data={n.data} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {!n.readAt && <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="Não lida" />}
                        <span className="min-w-0 break-words">{n.title}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">{formatDateTimeBR(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2">
          <Link href="/notificacoes" onClick={() => setOpen(false)} className="text-xs font-medium text-brand hover:underline">
            Ver todas
          </Link>
          <Link href="/configuracoes?tab=notificacoes" onClick={() => setOpen(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
            Preferências
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { BellOff, CheckCheck, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { NotificationIcon } from "./notification-icon";
import type { NotificationPage } from "./types";
import { useMarkAllNotificationsRead, useOpenNotification } from "./use-notifications";

const PAGE_SIZE = 30;

/** Caixa de notificações completa: paginada (cursor), filtro de não lidas e "marcar todas como lidas". */
export function NotificationsView() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useInfiniteQuery({
    queryKey: qk.notifications({ page: "all", unreadOnly }),
    queryFn: ({ pageParam }) => api.get<NotificationPage>("/api/v1/notifications", { limit: PAGE_SIZE, unreadOnly: unreadOnly || undefined, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const readAll = useMarkAllNotificationsRead();
  const openNotification = useOpenNotification();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = q.data?.pages[0]?.unreadCount ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notificações"
        description={q.data ? (unread ? `${unread} ${unread === 1 ? "não lida" : "não lidas"}` : "Tudo lido") : "Avisos de contas, faturas, metas e relatórios"}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/configuracoes?tab=notificacoes">
                <Settings /> Preferências
              </Link>
            </Button>
            <Button variant="brand" onClick={() => readAll.mutate()} disabled={!unread} loading={readAll.isPending}>
              <CheckCheck /> Marcar todas como lidas
            </Button>
          </>
        }
      />

      <div className="flex gap-1" role="group" aria-label="Filtrar notificações">
        <Button size="sm" variant={unreadOnly ? "outline" : "default"} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
          Todas
        </Button>
        <Button size="sm" variant={unreadOnly ? "default" : "outline"} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
          Não lidas
        </Button>
      </div>

      {q.isLoading ? (
        <div className="grid gap-2" aria-busy="true" aria-label="Carregando notificações">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={BellOff}
          title={unreadOnly ? "Nenhuma notificação não lida" : "Nenhuma notificação por aqui"}
          description={unreadOnly ? "Tudo em dia. Veja todas para rever os avisos anteriores." : "Lembretes de contas, faturas, metas e relatórios aparecem aqui."}
        />
      ) : (
        <Card className={cn("overflow-hidden transition-opacity", q.isFetching && !q.isFetchingNextPage && "opacity-70")}>
          <ul className="divide-y" aria-label="Notificações">
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => openNotification(n)} className={cn("flex w-full gap-3 px-4 py-3.5 text-left transition hover:bg-muted/50 sm:px-5", !n.readAt && "bg-accent/40")}>
                  <NotificationIcon type={n.type} data={n.data} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2 text-sm font-medium">
                      {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" aria-label="Não lida" />}
                      <span className="min-w-0 break-words">{n.title}</span>
                    </span>
                    <span className="mt-0.5 block break-words text-sm text-muted-foreground">{n.body}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {n.typeLabel} · {formatDateTimeBR(n.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button variant="ghost" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                Carregar mais
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

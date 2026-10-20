"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, LockKeyhole, MapPin, MessageCircle, Pencil, Plus, Trash2, BellRing } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { addDays, formatDayMonthBR, todayISO } from "@/lib/dates";
import { qk } from "@/lib/client/query-keys";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";
import { MorningSummarySettings } from "@/features/settings/morning-summary-settings";
import { AppointmentFormDialog } from "./appointment-form-dialog";
import { GoogleCalendarCard } from "./google-calendar-card";
import { dayLabel, groupByDay, reminderLabel, timeLabel } from "./format";
import type { AppointmentDTO } from "./types";
import { useAppointmentMutations, useAppointments } from "./use-agenda";

const RANGES = [
  { days: 7, label: "Próximos 7 dias" },
  { days: 30, label: "Próximos 30 dias" },
] as const;
type RangeDays = (typeof RANGES)[number]["days"];

/** Volta do consentimento do Google (/agenda?google=ok|erro&motivo=...): avisa uma vez e limpa o endereço. */
function useGoogleReturnToast() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const handled = useRef(false);
  const result = params.get("google");
  const reason = params.get("motivo");
  useEffect(() => {
    if (!result || handled.current) return;
    handled.current = true;
    if (result === "ok") toast.success("Google Agenda conectado", { description: "Seus eventos vão aparecer na agenda em instantes." });
    else toast.error("Não foi possível conectar o Google Agenda", { description: reason ?? undefined, duration: 10_000 });
    qc.invalidateQueries({ queryKey: qk.google });
    qc.invalidateQueries({ queryKey: ["agenda"] });
    router.replace("/agenda", { scroll: false });
  }, [result, reason, router, qc]);
}

function AppointmentItem({
  a,
  canWrite,
  onEdit,
  onDelete,
}: {
  a: AppointmentDTO;
  canWrite: boolean;
  onEdit: (a: AppointmentDTO) => void;
  onDelete: (a: AppointmentDTO) => void;
}) {
  const reminder = reminderLabel(a.reminderMinutes);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={cn("w-[4.5rem] shrink-0 pt-0.5 text-sm font-semibold tabular-nums", a.allDay || !a.time ? "text-muted-foreground" : "text-foreground")}>
        {a.allDay || !a.time ? "Dia todo" : a.time}
        {a.time && a.endTime && <span className="block text-xs font-normal text-muted-foreground">até {a.endTime}</span>}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">{a.title}</p>
        {a.location && (
          <p className="mt-0.5 flex items-start gap-1 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{a.location}</span>
          </p>
        )}
        {a.notes && <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{a.notes}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {a.visibility === "PRIVATE" && (
            <Badge variant="muted" className="max-w-full">
              <LockKeyhole aria-hidden />
              <span className="truncate">Privado{a.owner ? ` · ${a.owner.name}` : ""}</span>
            </Badge>
          )}
          {a.source === "GOOGLE" && <Badge variant="info">Do Google Agenda</Badge>}
          {a.source === "WHATSAPP" && (
            <Badge variant="positive">
              <MessageCircle aria-hidden /> Pelo WhatsApp
            </Badge>
          )}
          {reminder && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <BellRing className="size-3" aria-hidden /> {reminder}
            </span>
          )}
        </div>
        {a.readOnly && <p className="mt-1 text-xs text-muted-foreground">Para mudar ou desmarcar, altere no Google Agenda.</p>}
      </div>
      {canWrite && !a.readOnly && (
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon-sm" aria-label={`Editar ${a.title}`} title="Editar" onClick={() => onEdit(a)}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" aria-label={`Desmarcar ${a.title}`} title="Desmarcar" onClick={() => onDelete(a)}>
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  );
}

/** Agenda da família: próximos compromissos por dia, Google Agenda e resumo da manhã. */
export function AgendaView() {
  useGoogleReturnToast();
  const me = useMe();
  const canWrite = useCan("transactions:write");
  const today = todayISO(me.data?.household.timezone);
  const [days, setDays] = useState<RangeDays>(7);
  const [offset, setOffset] = useState(0);
  const range = useMemo(() => {
    const start = addDays(today, offset * days);
    return { start, end: addDays(start, days - 1) };
  }, [today, offset, days]);
  const q = useAppointments(range);
  const { remove } = useAppointmentMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AppointmentDTO | null>(null);
  const [deleting, setDeleting] = useState<AppointmentDTO | null>(null);
  const groups = useMemo(() => groupByDay(q.data ?? []), [q.data]);

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const rangeText = offset === 0 ? RANGES.find((r) => r.days === days)!.label : `${formatDayMonthBR(range.start)} a ${formatDayMonthBR(range.end)}`;

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title="Agenda"
        description="Compromissos da família, os seus privados e os eventos do Google Agenda."
        actions={
          canWrite && (
            <Button variant="brand" onClick={openNew}>
              <Plus /> Novo compromisso
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <section aria-label="Compromissos" className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Período">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  type="button"
                  role="radio"
                  aria-checked={days === r.days}
                  onClick={() => {
                    setDays(r.days);
                    setOffset(0);
                  }}
                  className={cn(
                    "h-8 rounded-lg px-3 text-sm font-medium transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    days === r.days ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Período anterior" onClick={() => setOffset((o) => o - 1)}>
                <ChevronLeft />
              </Button>
              {offset !== 0 && (
                <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>
                  Hoje
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Próximo período" onClick={() => setOffset((o) => o + 1)}>
                <ChevronRight />
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {rangeText}
            {offset !== 0 ? "" : ` · ${formatDayMonthBR(range.start)} a ${formatDayMonthBR(range.end)}`}
          </p>

          {q.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : !groups.length ? (
            <EmptyState
              icon={CalendarDays}
              title={offset === 0 ? "Nenhum compromisso por enquanto" : "Nenhum compromisso neste período"}
              description={
                <>
                  Marque aqui ou pelo WhatsApp, por exemplo: <q>marca dentista amanhã às 15h</q>. Para ver o dia, pergunte <q>agenda de hoje</q>.
                </>
              }
              action={
                canWrite && (
                  <Button variant="outline" onClick={openNew}>
                    <Plus /> Marcar o primeiro compromisso
                  </Button>
                )
              }
            />
          ) : (
            <div className={cn("space-y-4 transition-opacity", q.isFetching && q.isPlaceholderData && "opacity-60")}>
              {groups.map((g) => (
                <Card key={g.date} className="overflow-hidden p-0">
                  <h2 className="flex items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2 text-sm font-semibold">
                    <span>{dayLabel(g.date, today)}</span>
                    {(g.date === today || g.date === addDays(today, 1)) && <span className="text-xs font-normal text-muted-foreground">{formatDayMonthBR(g.date)}</span>}
                  </h2>
                  <ul className="divide-y">
                    {g.items.map((a) => (
                      <AppointmentItem
                        key={a.id}
                        a={a}
                        canWrite={canWrite}
                        onEdit={(x) => {
                          setEditing(x);
                          setFormOpen(true);
                        }}
                        onDelete={setDeleting}
                      />
                    ))}
                  </ul>
                </Card>
              ))}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5" aria-hidden /> Também dá para marcar pelo WhatsApp: <q>marca dentista amanhã às 15h</q>.
              </p>
            </div>
          )}
        </section>
        <aside className="min-w-0 space-y-4" aria-label="Ajustes da agenda">
          <MorningSummarySettings idPrefix="agenda-morning" compact />
          <GoogleCalendarCard />
        </aside>
      </div>

      <AppointmentFormDialog open={formOpen} onOpenChange={setFormOpen} appointment={editing} />
      <AlertDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desmarcar este compromisso?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `“${deleting.title}” (${dayLabel(deleting.date, today)}, ${timeLabel(deleting)}) sai da agenda${deleting.visibility === "PRIVATE" ? "" : " de toda a família"}.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (deleting) remove.mutate(deleting);
                setDeleting(null);
              }}
            >
              Desmarcar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

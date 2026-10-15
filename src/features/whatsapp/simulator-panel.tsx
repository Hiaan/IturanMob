"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCheck,
  CheckCircle2,
  FileText,
  FlaskConical,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  Mic,
  Paperclip,
  SendHorizontal,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RichText } from "@/components/shared/rich-text";
import { ErrorState } from "@/components/shared/error-state";
import { DEFAULT_TIMEZONE, formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMembers } from "@/features/finance/hooks";
import { useSimulate, useWhatsAppMessages, type SimulateInput } from "./hooks";
import { TransactionChips } from "./message-bits";
import { MESSAGE_STATUS_META, MESSAGE_TYPE_META } from "./status-meta";
import type { WaMessage, WaSimulateResult, WaStatus } from "./types";
import { SIMULATOR_MAX_FILE_BYTES, formatBytes, readFileAsBase64 } from "./utils";

const SUGGESTIONS = ["Gastei 45 reais na farmácia", "Quanto gastamos esse mês?", "Paguei 120 de luz no pix", "Recebi 3500 de salário", "Mercado 230,90 no cartão em 3x"];

type FileKind = "audio" | "image" | "document";

function kindOf(file: File): FileKind | null {
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf") return "document";
  return null;
}

function timeFmt(timezone: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
}

function dayKey(iso: string, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function OutcomeCard({ result }: { result: WaSimulateResult | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Último envio</CardTitle>
        <CardDescription>Resultado devolvido pela simulação.</CardDescription>
      </CardHeader>
      <CardContent>
        {!result ? (
          <p className="text-sm text-muted-foreground">Envie uma mensagem para ver como ela foi recebida e processada.</p>
        ) : !result.accepted ? (
          <div className="flex gap-2 text-sm">
            <XCircle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden />
            <div>
              <p className="font-medium text-negative">Mensagem descartada (nada foi armazenado)</p>
              <p className="text-muted-foreground">{result.reasonLabel ?? result.reason}</p>
            </div>
          </div>
        ) : (
          <dl className="grid gap-2 text-sm">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
              <div>
                <dt className="font-medium">Recebida pelo mesmo fluxo das mensagens reais</dt>
                <dd className="text-muted-foreground">
                  {result.mode === "inline"
                    ? "Processada direto pela API (worker parado)."
                    : result.mode === "worker"
                      ? "Enviada para a fila do worker."
                      : result.status
                        ? `Status: ${MESSAGE_STATUS_META[result.status].label}.`
                        : null}
                </dd>
              </div>
            </div>
            {result.outcome && (
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
                <div>
                  <dt className="font-medium">Processamento</dt>
                  <dd className="text-muted-foreground">
                    {result.outcome.outcome === "SUCCEEDED" || result.outcome.outcome === "FAILED"
                      ? `${MESSAGE_STATUS_META[result.outcome.messageStatus].label} · ${result.outcome.replies} resposta(s) do bot`
                      : result.outcome.outcome === "RETRY_SCHEDULED"
                        ? `Falhou na tentativa ${result.outcome.attempts}; nova tentativa agendada.`
                        : result.outcome.outcome === "DEAD"
                          ? `Falhou após ${result.outcome.attempts} tentativas — virou pendência.`
                          : `Ignorado (${result.outcome.reason}).`}
                  </dd>
                </div>
              </div>
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Bubble({ m, mine, timezone, color }: { m: WaMessage; mine: boolean; timezone: string; color?: string }) {
  const statusMeta = MESSAGE_STATUS_META[m.status];
  const StatusIcon = statusMeta.icon;
  const att = m.attachment && !m.attachment.contentDeleted ? m.attachment : null;
  const TypeIcon = MESSAGE_TYPE_META[m.type].icon;
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-xs sm:max-w-[75%]",
          mine ? "rounded-tr-sm bg-accent text-foreground" : "rounded-tl-sm border bg-card",
        )}
      >
        {!mine && (
          <p className="mb-0.5 flex items-center gap-1 text-xs font-semibold" style={m.isBot ? undefined : { color }}>
            {m.isBot ? (
              <>
                <Bot className="size-3.5 text-brand" aria-hidden /> <span className="text-brand">Finance AI</span>
              </>
            ) : (
              (m.sender?.displayName ?? "Participante")
            )}
          </p>
        )}
        {m.type !== "TEXT" && (
          <div className="mb-1">
            {att && m.type === "IMAGE" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/v1/attachments/${att.id}`} alt="Imagem enviada" className="max-h-48 rounded-lg border object-cover" />
            ) : att && m.type === "AUDIO" ? (
              <audio controls src={`/api/v1/attachments/${att.id}`} className="h-9 w-56 max-w-full" />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <TypeIcon className="size-3.5" aria-hidden /> {MESSAGE_TYPE_META[m.type].label}
              </span>
            )}
          </div>
        )}
        {m.text?.trim() ? (
          m.isBot ? (
            <RichText text={m.text} className="space-y-0.5 break-words" />
          ) : (
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
          )
        ) : null}
        {!m.isBot && m.transactions.length > 0 && <TransactionChips message={m} className="mt-1.5" />}
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
          {!m.isBot && (
            <span className={cn("inline-flex items-center gap-0.5")} title={statusMeta.label}>
              <StatusIcon className={cn("size-3", statusMeta.spin && "animate-spin")} aria-hidden />
              {statusMeta.label}
            </span>
          )}
          <span>{timeFmt(timezone).format(new Date(m.sentAt))}</span>
          {m.isBot && <CheckCheck className="size-3.5 text-info" aria-label="Registrada" />}
        </div>
        {!m.isBot && m.statusDetail && (m.status === "IGNORED" || m.status === "FAILED" || m.status === "NEEDS_CLARIFICATION") && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{m.statusDetail}</p>
        )}
      </div>
    </div>
  );
}

export function SimulatorPanel({ status, canManage, timezone, onGoToConnection }: { status: WaStatus; canManage: boolean; timezone?: string; onGoToConnection: () => void }) {
  const tz = timezone ?? DEFAULT_TIMEZONE;
  const members = useMembers();
  const colors = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.color])), [members.data]);
  const me = members.data?.find((m) => m.isMe);
  const ready = status.members.filter((m) => m.ready);
  const [memberId, setMemberId] = useState<string>("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ file: File; kind: FileKind } | null>(null);
  const [result, setResult] = useState<WaSimulateResult | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const simulate = useSimulate();

  const selected = ready.find((m) => m.id === memberId)?.id ?? (ready.find((m) => m.id === me?.id) ?? ready[0])?.id ?? "";

  const messages = useWhatsAppMessages({ limit: 50 }, { refetchInterval: 4000 });
  const items = useMemo(() => [...(messages.data?.pages[0]?.items ?? [])].reverse(), [messages.data]);
  const inFlight = items.some((m) => m.status === "QUEUED" || m.status === "PROCESSING");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items.length, pendingText, inFlight]);

  const blocked = !canManage
    ? "Somente quem administra as integrações pode enviar mensagens simuladas."
    : status.simulator && !status.simulator.enabled
      ? "O simulador está desabilitado neste ambiente."
      : !status.authorizedGroup
        ? "Autorize o grupo simulado na aba Conexão para começar."
        : ready.length === 0
          ? "Nenhum participante pronto: cadastre o número, autorize e dê o consentimento em Configurações › Membros."
          : null;

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    const kind = kindOf(f);
    if (!kind) {
      toast.error("Formato não suportado. Envie áudio, imagem ou PDF.");
      return;
    }
    if (f.size > SIMULATOR_MAX_FILE_BYTES) {
      toast.error(`Arquivo de ${formatBytes(f.size)}: o simulador aceita até ${formatBytes(SIMULATOR_MAX_FILE_BYTES)}.`);
      return;
    }
    setFile({ file: f, kind });
  };

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if (blocked || simulate.isPending || !selected) return;
    if (!body && !file) return;
    const input: SimulateInput = { memberId: selected };
    if (body) input.text = body;
    if (file) {
      try {
        const b64 = await readFileAsBase64(file.file);
        if (file.kind === "audio") input.audioBase64 = b64;
        else if (file.kind === "image") input.imageBase64 = b64;
        else input.documentBase64 = b64;
        input.mimeType = file.file.type || undefined;
        input.fileName = file.file.name.slice(0, 200);
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
    }
    setPendingText(body || (file ? `(${file.kind === "audio" ? "áudio" : file.kind === "image" ? "imagem" : "documento"})` : ""));
    const previousText = text;
    const previousFile = file;
    setText("");
    setFile(null);
    simulate.mutate(input, {
      onSuccess: (res) => {
        setResult(res);
        if (!res.accepted) toast.warning("Mensagem descartada", { description: res.reasonLabel ?? undefined });
      },
      onError: () => {
        setText(previousText);
        setFile(previousFile);
      },
      onSettled: () => setPendingText(null),
    });
  };

  let lastDay = "";

  return (
    <div className="space-y-4">
      <div role="note" className="flex items-start gap-3 rounded-xl border border-info/30 bg-info/8 p-4 text-sm">
        <FlaskConical className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
        <p className="text-foreground/85">
          <strong className="text-info">Simulação — nenhuma mensagem é enviada a um WhatsApp real.</strong> Escolha um participante e escreva como se fosse no grupo da família: a
          mensagem passa pelo mesmo processamento (lançamentos, consultas, pendências) e a resposta do bot aparece abaixo.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex items-center gap-3 bg-primary px-4 py-3 text-primary-foreground">
            <span className="flex size-9 items-center justify-center rounded-full bg-white/15" aria-hidden>
              <Users className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{status.authorizedGroup?.name ?? "Grupo simulado"}</p>
              <p className="truncate text-xs opacity-80">{ready.map((m) => m.displayName).join(", ") || "Sem participantes prontos"} · Finance AI</p>
            </div>
            <Badge className="border-white/20 bg-white/15 text-primary-foreground">
              <FlaskConical aria-hidden /> Simulação
            </Badge>
          </div>

          <div
            ref={scrollRef}
            className="h-[min(62dvh,560px)] space-y-2 overflow-y-auto bg-muted/50 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px] px-3 py-4 sm:px-5"
            aria-live="polite"
            aria-label="Conversa simulada"
          >
            {messages.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
                <Skeleton className="h-16 w-3/4 rounded-2xl" />
              </div>
            ) : messages.isError ? (
              <ErrorState error={messages.error} compact onRetry={() => messages.refetch()} />
            ) : items.length === 0 && !pendingText ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <Bot className="size-8 text-brand" aria-hidden />
                <p className="font-medium text-foreground">Nenhuma mensagem ainda</p>
                <p className="max-w-xs">Experimente “Gastei 45 reais na farmácia” ou “Quanto gastamos esse mês?”.</p>
              </div>
            ) : (
              items.map((m) => {
                const day = dayKey(m.sentAt, tz);
                const showDay = day !== lastDay;
                lastDay = day;
                return (
                  <div key={m.id} className="space-y-2">
                    {showDay && (
                      <div className="flex justify-center">
                        <span className="rounded-full bg-card px-3 py-0.5 text-[11px] font-medium text-muted-foreground shadow-xs">
                          {day === dayKey(new Date().toISOString(), tz) ? "Hoje" : formatDateBR(day)}
                        </span>
                      </div>
                    )}
                    <Bubble m={m} mine={!m.isBot && m.sender?.id === selected} timezone={tz} color={m.sender ? colors.get(m.sender.id) : undefined} />
                  </div>
                );
              })
            )}
            {pendingText !== null && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-sm opacity-80 sm:max-w-[75%]">
                  <p className="whitespace-pre-wrap break-words">{pendingText}</p>
                  <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" aria-hidden /> enviando e processando…
                  </p>
                </div>
              </div>
            )}
            {inFlight && pendingText === null && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" aria-hidden /> O worker está processando…
              </p>
            )}
          </div>

          <div className="space-y-2 border-t bg-card p-3">
            {blocked ? (
              <div className="flex flex-col items-start gap-2 rounded-lg bg-warning/8 p-3 text-sm text-warning sm:flex-row sm:items-center sm:justify-between">
                <span className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {blocked}
                </span>
                {canManage && !status.authorizedGroup && (
                  <Button size="sm" variant="outline" onClick={onGoToConnection}>
                    Ir para Conexão
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      disabled={simulate.isPending}
                      className="rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground transition hover:border-ring/50 hover:text-foreground disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Select value={selected} onValueChange={setMemberId}>
                    <SelectTrigger className="sm:w-48" aria-label="Enviar como">
                      <SelectValue placeholder="Enviar como…" />
                    </SelectTrigger>
                    <SelectContent>
                      {ready.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex min-w-0 flex-1 items-end gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/*,image/*,application/pdf"
                      className="sr-only"
                      tabIndex={-1}
                      aria-hidden
                      onChange={(e) => {
                        pickFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <Button type="button" variant="outline" size="icon" aria-label="Anexar áudio, imagem ou PDF" onClick={() => fileRef.current?.click()} disabled={simulate.isPending}>
                      <Paperclip />
                    </Button>
                    <Textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      rows={1}
                      maxLength={4000}
                      placeholder={file ? "Legenda (opcional)" : "Mensagem"}
                      aria-label="Mensagem simulada"
                      className="max-h-32 min-h-10 resize-none"
                    />
                    <Button type="button" variant="brand" size="icon" aria-label="Enviar" onClick={() => send()} loading={simulate.isPending} disabled={!text.trim() && !file}>
                      {!simulate.isPending && <SendHorizontal />}
                    </Button>
                  </div>
                </div>
                {file && (
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                    {file.kind === "audio" ? <Mic className="size-4" aria-hidden /> : file.kind === "image" ? <ImageIcon className="size-4" aria-hidden /> : <FileText className="size-4" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">
                      {file.file.name} · {formatBytes(file.file.size)}
                    </span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remover anexo" onClick={() => setFile(null)}>
                      <X />
                    </Button>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">Enter envia · Shift+Enter quebra linha · anexos de até {formatBytes(SIMULATOR_MAX_FILE_BYTES)} (áudio, imagem ou PDF).</p>
              </>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <OutcomeCard result={result} />
          <Card>
            <CardHeader>
              <CardTitle>Como funciona</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">Worker em execução:</strong> a mensagem entra na mesma fila das mensagens reais e o worker responde em alguns segundos.
              </p>
              <p>
                <strong className="text-foreground">Worker parado:</strong> a própria API processa a mensagem na hora e registra a resposta do bot.
              </p>
              <p>Somente participantes autorizados e com consentimento aparecem em “Enviar como”. Lançamentos criados aparecem em Transações com a origem “WhatsApp”.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, MessageSquarePlus, Send, Sparkles, Trash2, User, Wrench } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RichText } from "@/components/shared/rich-text";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  _count: { messages: number };
}

interface Message {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: string;
  metadata: { engine?: string; model?: string | null; tools?: string[]; fallbackReason?: string | null } | null;
}

const SUGGESTIONS = [
  "Quanto gastamos este mês?",
  "Quanto gastamos com alimentação este mês?",
  "Compara nossos gastos de agosto e setembro",
  "Quais são as cinco maiores despesas?",
  "Quanto ainda podemos gastar com alimentação?",
  "Quais contas ainda faltam pagar?",
  "Quais assinaturas estão ativas?",
  "Qual foi nossa média de gastos com alimentação nos últimos três meses?",
];

const TOOL_LABELS: Record<string, string> = {
  resumo_periodo: "Resumo do período",
  buscar_transacoes: "Busca de transações",
  gastos_por_categoria: "Gastos por categoria",
  comparar_periodos: "Comparação de períodos",
  maiores_despesas: "Maiores despesas",
  status_orcamento: "Orçamento",
  contas_a_pagar: "Contas a pagar",
  faturas_cartao: "Faturas",
  metas: "Metas",
  recorrencias: "Recorrências",
  saldos: "Saldos",
  media_gastos: "Média de gastos",
  ritmo_do_mes: "Ritmo do mês (projeção)",
  projecao_fluxo_caixa: "Projeção de caixa",
  gastos_por_pessoa: "Gastos por pessoa",
};

export function AssistantView() {
  const qc = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversations = useQuery({ queryKey: qk.assistant({ list: true }), queryFn: () => api.get<Conversation[]>("/api/v1/assistant/conversations") });
  const conversation = useQuery({
    queryKey: qk.assistant({ id: conversationId }),
    queryFn: () => api.get<{ id: string; title: string; messages: Message[] }>(`/api/v1/assistant/conversations/${conversationId}`),
    enabled: Boolean(conversationId),
  });

  const ask = useMutation({
    mutationFn: (q: string) => api.post<{ conversationId: string }>("/api/v1/assistant/ask", { conversationId, question: q }),
    onMutate: (q) => {
      setOptimistic(q);
      setQuestion("");
    },
    onSuccess: async (res) => {
      setConversationId(res.conversationId);
      await qc.invalidateQueries({ queryKey: qk.assistant({ id: res.conversationId }) });
      qc.invalidateQueries({ queryKey: qk.assistant({ list: true }) });
    },
    onError: (e, q) => {
      toast.error(errorMessage(e));
      setQuestion(q);
    },
    onSettled: () => setOptimistic(null),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/assistant/conversations/${id}`),
    onSuccess: (_d, id) => {
      if (id === conversationId) setConversationId(null);
      qc.invalidateQueries({ queryKey: qk.assistant({ list: true }) });
    },
  });

  const messages = conversationId ? conversation.data?.messages ?? [] : [];
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, optimistic]);

  const submit = (q?: string) => {
    const text = (q ?? question).trim();
    if (!text || ask.isPending) return;
    ask.mutate(text);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Isa, sua assistente" description="Pergunte do seu jeito sobre as finanças da família. A Isa responde só com os dados registrados." />
      {/* No celular a lista lateral fica oculta: as conversas anteriores ficam neste seletor. */}
      {Boolean(conversations.data?.length) && (
        <div className="lg:hidden">
          <Select value={conversationId ?? "nova"} onValueChange={(v) => setConversationId(v === "nova" ? null : v)}>
            <SelectTrigger className="w-full" aria-label="Conversa">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="nova">Nova conversa</SelectItem>
              {(conversations.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="hidden h-[calc(100dvh-12rem)] flex-col overflow-hidden lg:flex">
          <div className="border-b p-3">
            <Button variant="outline" className="w-full" onClick={() => setConversationId(null)}>
              <MessageSquarePlus /> Nova conversa
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {conversations.isLoading ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : !conversations.data?.length ? (
              <p className="p-3 text-sm text-muted-foreground">Suas conversas aparecerão aqui.</p>
            ) : (
              <ul className="space-y-1">
                {conversations.data.map((c) => (
                  <li key={c.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => setConversationId(c.id)}
                      className={cn("w-full rounded-lg px-3 py-2 pr-9 text-left text-sm transition hover:bg-muted", c.id === conversationId && "bg-muted")}
                    >
                      <p className="truncate font-medium">{c.title}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTimeBR(c.updatedAt)}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => remove.mutate(c.id)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                      aria-label="Excluir conversa"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card className="flex h-[calc(100dvh-12rem)] min-h-[480px] flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 sm:p-6" aria-live="polite">
            {!messages.length && !optimistic ? (
              <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                  <Sparkles className="size-6" />
                </span>
                <p className="mt-4 text-lg font-semibold">Como posso ajudar?</p>
                <p className="mt-1 text-sm text-muted-foreground">Dados confirmados, estimativas e projeções são sempre identificados na resposta.</p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => submit(s)} className="rounded-full border bg-card px-3 py-1.5 text-sm transition hover:border-brand/40 hover:bg-accent/50">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-5">
                {messages.map((m) => (
                  <ChatBubble key={m.id} message={m} />
                ))}
                {optimistic && (
                  <>
                    <ChatBubble message={{ id: "opt", role: "USER", content: optimistic, createdAt: new Date().toISOString(), metadata: null }} />
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-foreground">
                        <Bot className="size-4" />
                      </span>
                      <span className="animate-pulse">Consultando os dados…</span>
                    </div>
                  </>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
          <form
            className="border-t bg-card p-3 sm:p-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={1}
                maxLength={1000}
                placeholder="Pergunte sobre gastos, orçamentos, contas a pagar…"
                className="max-h-40 min-h-11 resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                aria-label="Pergunta para a Isa"
              />
              <Button type="submit" variant="brand" size="icon" className="size-11 shrink-0" loading={ask.isPending} disabled={!question.trim()} aria-label="Enviar">
                {!ask.isPending && <Send />}
              </Button>
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-[11px] text-muted-foreground">A Isa aqui no painel apenas consulta dados; registros e correções são feitos pelo WhatsApp ou pelo painel.</p>
          </form>
        </Card>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === "USER";
  const meta = message.metadata;
  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", isUser ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground")}>
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </span>
      <div className={cn("max-w-[85%] space-y-2", isUser && "text-right")}>
        <div className={cn("inline-block rounded-2xl px-4 py-2.5 text-left text-sm leading-relaxed", isUser ? "bg-primary text-primary-foreground" : "border bg-card")}>
          {isUser ? <p className="whitespace-pre-wrap">{message.content}</p> : <RichText text={message.content} className="space-y-1" />}
        </div>
        {!isUser && meta && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="muted">{meta.engine === "LOCAL" ? "Motor local" : meta.engine === "ANTHROPIC" ? "Claude" : meta.engine ?? "—"}</Badge>
            {(meta.tools ?? []).map((t, i) => (
              <Badge key={`${t}-${i}`} variant="outline" className="gap-1">
                <Wrench className="size-3" /> {TOOL_LABELS[t] ?? t}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

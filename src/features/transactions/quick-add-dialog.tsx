"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, MessageSquareText, PenLine, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { api, errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { TransactionForm } from "./transaction-form";

export interface InterpretDraft {
  index: number;
  type: string;
  amountCents: number | null;
  description: string;
  date: string;
  categoryName: string | null;
  subcategoryName: string | null;
  paymentMethod: string | null;
  accountName: string | null;
  creditCardName: string | null;
  installmentCount: number;
  responsibleName: string | null;
  merchant: string | null;
  confidence: number;
  missing: string[];
  warnings: string[];
}

export interface InterpretResponse {
  intent: string;
  engine: string;
  message: string | null;
  drafts: InterpretDraft[];
  requiresConfirmation: boolean;
}

/** `autoFocus` só no diálogo: no dashboard, focar ao carregar rolaria a página até o campo (e abriria o teclado). */
export function NaturalLanguageEntry({ onDone, autoFocus = true }: { onDone: () => void; autoFocus?: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [result, setResult] = useState<InterpretResponse | null>(null);

  const interpret = useMutation({
    mutationFn: (t: string) => api.post<InterpretResponse>("/api/v1/ai/interpret", { text: t }),
    onSuccess: setResult,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const apply = useMutation({
    mutationFn: () => api.post<{ created: number; message: string }>("/api/v1/ai/apply", { text }),
    onSuccess: (res) => {
      toast.success(res.message);
      ["transactions", "accounts", "cards", "analytics", "pending", "me", "goals"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setText("");
      setResult(null);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const canApply = result && result.intent === "CREATE_TRANSACTIONS" && result.drafts.length > 0 && result.drafts.every((d) => d.amountCents && d.missing.length === 0);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          rows={3}
          maxLength={1000}
          placeholder={'Escreva como no WhatsApp. Ex.: "Mercado 283,90 no Nubank" ou "Hoje gastei 80 de gasolina e 35 na farmácia"'}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) interpret.mutate(text.trim());
          }}
          autoFocus={autoFocus}
          aria-label="Lançamento em linguagem natural"
        />
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={() => interpret.mutate(text.trim())} disabled={!text.trim()} loading={interpret.isPending}>
            <Sparkles /> Interpretar
          </Button>
        </div>
      </div>

      {result && (
        <div className="grid gap-3 rounded-xl border bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Pré-visualização</p>
            <Badge variant="muted">{result.engine}</Badge>
          </div>
          {result.message && <p className="whitespace-pre-line text-sm text-muted-foreground">{result.message}</p>}
          {result.drafts.map((d) => (
            <div key={d.index} className="rounded-lg border bg-card p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{d.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {labelOf(TRANSACTION_TYPE_LABELS, d.type)} · {formatDateBR(d.date)}
                    {d.categoryName && ` · ${d.categoryName}${d.subcategoryName ? ` › ${d.subcategoryName}` : ""}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[d.paymentMethod && labelOf(PAYMENT_METHOD_LABELS, d.paymentMethod), d.creditCardName ?? d.accountName, d.installmentCount > 1 && `${d.installmentCount}x`, d.responsibleName]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <p className="text-base font-semibold tabular">{d.amountCents ? formatBRL(d.amountCents) : "—"}</p>
              </div>
              {(d.missing.length > 0 || d.warnings.length > 0) && (
                <ul className="mt-2 space-y-1">
                  {d.missing.map((m) => (
                    <li key={m} className="flex items-center gap-1.5 text-xs text-warning">
                      <CircleAlert className="size-3.5" /> Falta informar: {m}
                    </li>
                  ))}
                  {d.warnings.map((w) => (
                    <li key={w} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CircleAlert className="size-3.5" /> {w}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">Confiança: {Math.round(d.confidence * 100)}%</p>
            </div>
          ))}
          {result.intent === "CREATE_TRANSACTIONS" ? (
            <div className="flex justify-end">
              <Button type="button" variant="brand" onClick={() => apply.mutate()} disabled={!canApply} loading={apply.isPending}>
                <CheckCircle2 /> Confirmar {result.drafts.length > 1 ? `${result.drafts.length} lançamentos` : "lançamento"}
              </Button>
            </div>
          ) : (
            result.intent !== "QUERY" && <p className="text-xs text-muted-foreground">Esta mensagem não gera lançamento. Use o Assistente IA para consultas.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function QuickAddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState("form");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Novo lançamento</DialogTitle>
          <DialogDescription>Registre pelo formulário ou escreva em linguagem natural.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="form">
              <PenLine /> Formulário
            </TabsTrigger>
            <TabsTrigger value="nl">
              <MessageSquareText /> Linguagem natural
            </TabsTrigger>
          </TabsList>
          <TabsContent value="form">
            {open && tab === "form" && <TransactionForm onSaved={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />}
          </TabsContent>
          <TabsContent value="nl">{open && tab === "nl" && <NaturalLanguageEntry onDone={() => onOpenChange(false)} />}</TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

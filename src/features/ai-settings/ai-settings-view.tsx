"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, KeyRound, PlugZap, ShieldAlert, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { AI_PROVIDER_LABELS, AI_TASK_LABELS, labelOf } from "@/lib/labels";
import { useCan } from "@/features/me/use-me";

type ProviderType = "ANTHROPIC" | "OPENAI" | "OPENAI_COMPATIBLE" | "LOCAL";

interface AIConfig {
  consent: { aiExternalAllowed: boolean; aiAudioAllowed: boolean; aiImageAllowed: boolean };
  defaults: { provider: ProviderType; transcription: string };
  providers: Array<{ type: Exclude<ProviderType, "LOCAL">; configured: boolean; source: "database" | "env" | null; baseUrl: string | null; storedAt: string | null; defaultModel: string }>;
  tasks: Array<{ task: keyof typeof AI_TASK_LABELS; provider: ProviderType; model: string; enabled: boolean; customized: boolean; effective: { provider: string; model: string; reason: string | null } | null }>;
}

interface AILog {
  id: string;
  task: string;
  provider: string;
  model: string;
  status: "SUCCESS" | "ERROR" | "FALLBACK";
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  createdAt: string;
}

const TASK_HELP: Record<string, string> = {
  PARSE_MESSAGE: "Converte mensagens (texto e transcrições) em lançamentos estruturados.",
  RECEIPT_EXTRACTION: "Lê fotos de comprovantes e notas fiscais (exige modelo com visão).",
  TRANSCRIPTION: "Transcreve áudios do WhatsApp (API compatível com Whisper).",
  ASSISTANT: "Responde perguntas no painel e no grupo usando ferramentas somente leitura.",
  INSIGHTS: "Análise de padrões e gastos atípicos.",
};

function ProviderCard({ p, canManage }: { p: AIConfig["providers"][number]; canManage: boolean }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? "");
  const save = useMutation({
    mutationFn: () => api.put("/api/v1/ai/credentials", { provider: p.type, apiKey, baseUrl: baseUrl || null }),
    onSuccess: () => {
      toast.success("Chave salva com criptografia");
      setApiKey("");
      qc.invalidateQueries({ queryKey: qk.ai() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/api/v1/ai/credentials", { provider: p.type }),
    onSuccess: () => {
      toast.success("Chave removida");
      qc.invalidateQueries({ queryKey: qk.ai() });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; latencyMs: number; model: string; error?: string }>("/api/v1/ai/test", { provider: p.type }),
    onSuccess: (r) => (r.ok ? toast.success(`Conexão OK (${r.model}, ${r.latencyMs} ms)`) : toast.error(r.error ?? "Falha no teste")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          {labelOf(AI_PROVIDER_LABELS, p.type)}
          {p.configured ? (
            <Badge variant="positive">
              <CheckCircle2 /> {p.source === "env" ? "via variável de ambiente" : "chave cadastrada"}
            </Badge>
          ) : (
            <Badge variant="muted">não configurado</Badge>
          )}
        </CardTitle>
        <CardDescription>Modelo padrão: {p.defaultModel}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {canManage && (
          <>
            <Field label="Chave de API" htmlFor={`key-${p.type}`} hint={p.source === "database" && p.storedAt ? `Cadastrada em ${formatDateTimeBR(p.storedAt)}. A chave nunca é exibida novamente.` : "Armazenada criptografada (AES-256-GCM)."}>
              <Input id={`key-${p.type}`} type="password" autoComplete="off" placeholder={p.configured ? "•••••••• (substituir)" : "Cole a chave"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            {p.type !== "ANTHROPIC" && (
              <Field label="URL base (opcional)" htmlFor={`url-${p.type}`} hint={p.type === "OPENAI_COMPATIBLE" ? "Ex.: http://ollama:11434/v1 ou servidor Whisper local" : "Deixe vazio para a API oficial"}>
                <Input id={`url-${p.type}`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </Field>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="brand" size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={apiKey.trim().length < 8}>
                <KeyRound /> Salvar chave
              </Button>
              <Button variant="outline" size="sm" onClick={() => test.mutate()} loading={test.isPending} disabled={!p.configured}>
                <PlugZap /> Testar conexão
              </Button>
              {p.source === "database" && (
                <Button variant="ghost" size="sm" onClick={() => remove.mutate()} loading={remove.isPending}>
                  <Trash2 /> Remover
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">O teste usa um texto sintético — nenhum dado da família é enviado.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TaskRow({ t, providers, canManage }: { t: AIConfig["tasks"][number]; providers: AIConfig["providers"]; canManage: boolean }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderType>(t.provider);
  const [model, setModel] = useState(t.model);
  const [enabled, setEnabled] = useState(t.enabled);
  useEffect(() => {
    setProvider(t.provider);
    setModel(t.model);
    setEnabled(t.enabled);
  }, [t]);
  const save = useMutation({
    mutationFn: () => api.put("/api/v1/ai/config/tasks", { items: [{ task: t.task, provider, model, enabled }] }),
    onSuccess: () => {
      toast.success(`${labelOf(AI_TASK_LABELS, t.task)}: configuração salva`);
      qc.invalidateQueries({ queryKey: qk.ai() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const options: ProviderType[] = t.task === "TRANSCRIPTION" ? ["OPENAI", "OPENAI_COMPATIBLE", "LOCAL"] : ["LOCAL", "ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE"];
  const dirty = provider !== t.provider || model !== t.model || enabled !== t.enabled;
  const effective = t.effective;
  return (
    <div className="grid gap-3 rounded-xl border p-4 lg:grid-cols-[1.3fr_1fr_1fr_auto] lg:items-end">
      <div>
        <p className="font-medium">{labelOf(AI_TASK_LABELS, t.task)}</p>
        <p className="text-xs text-muted-foreground">{TASK_HELP[t.task]}</p>
        {t.task === "TRANSCRIPTION" && (!effective || effective.provider === "LOCAL") ? (
          <p className="mt-1.5 flex items-start gap-1 text-xs">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Em uso: <strong>desativada</strong> <span className="text-muted-foreground">— áudios viram pendência para digitar o lançamento.</span>
            </span>
          </p>
        ) : t.task === "RECEIPT_EXTRACTION" && effective?.provider === "LOCAL" ? (
          <p className="mt-1.5 flex items-start gap-1 text-xs">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Em uso: <strong>só a legenda da foto</strong> <span className="text-muted-foreground">— a leitura automática exige um modelo com visão.</span>
            </span>
          </p>
        ) : effective && (
          <p className="mt-1.5 flex items-start gap-1 text-xs">
            {effective.reason ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" /> : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-positive" />}
            <span>
              Em uso: <strong>{labelOf(AI_PROVIDER_LABELS, effective.provider).split(" (")[0]}</strong>
              {effective.provider !== "LOCAL" && ` · ${effective.model}`}
              {effective.reason && <span className="text-muted-foreground"> — {effective.reason}</span>}
            </span>
          </p>
        )}
      </div>
      <Field label="Provedor" htmlFor={`prov-${t.task}`}>
        <Select value={provider} onValueChange={(v) => setProvider(v as ProviderType)} disabled={!canManage}>
          <SelectTrigger id={`prov-${t.task}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {o === "LOCAL" ? (t.task === "TRANSCRIPTION" ? "Desativada" : "Motor local") : labelOf(AI_PROVIDER_LABELS, o)}
                {o !== "LOCAL" && !providers.find((p) => p.type === o)?.configured ? " (sem chave)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Modelo" htmlFor={`model-${t.task}`}>
        <Input id={`model-${t.task}`} value={model} onChange={(e) => setModel(e.target.value)} disabled={!canManage || provider === "LOCAL"} />
      </Field>
      {canManage && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} /> Ativa
          </label>
          <Button variant="outline" size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
            Salvar
          </Button>
        </div>
      )}
    </div>
  );
}

export function AiSettingsView() {
  const canManage = useCan("integrations:manage");
  const config = useQuery({ queryKey: qk.ai({ config: true }), queryFn: () => api.get<AIConfig>("/api/v1/ai/config") });
  const logs = useQuery({ queryKey: qk.ai({ logs: true }), queryFn: () => api.get<AILog[]>("/api/v1/ai/logs", { limit: 30 }), enabled: canManage });

  if (config.isLoading || !config.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Inteligência artificial" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }
  const c = config.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Inteligência artificial"
        description="Escolha o provedor e o modelo de cada tarefa. Sem provedor externo (ou sem autorização), o motor local em português é usado — sem enviar dados a terceiros."
      />
      {!c.consent.aiExternalAllowed && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
            <ShieldAlert className="size-6 shrink-0 text-warning" />
            <div className="flex-1 text-sm">
              <p className="font-medium">O uso de IA externa ainda não foi autorizado pela família.</p>
              <p className="text-muted-foreground">Mesmo com chaves configuradas, mensagens e perguntas serão processadas pelo motor local até a autorização em Configurações → Privacidade e IA.</p>
            </div>
            <Button variant="outline" asChild>
              <Link href="/configuracoes?tab=privacidade">Revisar autorização</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Provedores</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {c.providers.map((p) => (
            <ProviderCard key={p.type} p={p} canManage={canManage} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Tarefas</h2>
        <div className="grid gap-3">
          {c.tasks.map((t) => (
            <TaskRow key={t.task} t={t} providers={c.providers} canManage={canManage} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Toda saída de IA é validada antes de gravar: valores precisam constar na mensagem, referências são conferidas com os cadastros da família e a confiança define se o lançamento é automático, pendente ou se o sistema pergunta.
        </p>
      </section>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Uso recente</CardTitle>
            <CardDescription>Registro técnico das chamadas (sem o conteúdo das mensagens).</CardDescription>
          </CardHeader>
          <CardContent>
            {!logs.data?.length ? (
              <p className="text-sm text-muted-foreground">Nenhuma chamada a provedores externos registrada.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Tarefa</TableHead>
                    <TableHead>Provedor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Latência</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.data.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTimeBR(l.createdAt)}</TableCell>
                      <TableCell>{labelOf(AI_TASK_LABELS, l.task)}</TableCell>
                      <TableCell className="text-xs">
                        {l.provider} · {l.model}
                      </TableCell>
                      <TableCell>
                        <Badge variant={l.status === "SUCCESS" ? "positive" : l.status === "FALLBACK" ? "warning" : "negative"} title={l.error ?? undefined}>
                          {l.status === "SUCCESS" ? "Sucesso" : l.status === "FALLBACK" ? "Motor local usado" : "Erro"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular">{l.latencyMs} ms</TableCell>
                      <TableCell className="text-right tabular">{l.inputTokens != null ? `${l.inputTokens} / ${l.outputTokens ?? 0}` : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

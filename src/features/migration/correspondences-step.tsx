"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, CheckCheck, Eye, ListChecks, Search, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, normalizeText } from "@/lib/utils";
import type { Correspondence, CorrespondenceDecision, CorrespondenceField, MigrationDTO } from "@/server/modules/migration/types";
import { CORRESPONDENCE_FIELDS, CORRESPONDENCE_FIELD_LABELS, pendingSuggestions, pendingTotal, plural } from "./labels";
import { CorrespondenceRow } from "./correspondence-row";
import { CreateCategoryDialog, CreateDestinationDialog } from "./create-dialogs";
import { OptionsPanel } from "./options-panel";
import { useApplySuggestions, useGeneratePreview, useMigrationBusy, useSuggestWithAI, useUpdateCorrespondences } from "./use-migration";

type Filter = "ALL" | "PENDING" | "SUGGESTED";
const PAGE = 60;

const FILTERS: Array<{ id: Filter; label: string; test: (c: Correspondence) => boolean }> = [
  { id: "ALL", label: "Todos", test: () => true },
  { id: "PENDING", label: "Pendentes", test: (c) => !c.decision },
  { id: "SUGGESTED", label: "Com sugestão", test: (c) => !c.decision && Boolean(c.suggestion) },
];

const FIELD_HELP: Record<CorrespondenceField, string> = {
  category: "Para cada categoria da planilha, escolha a categoria do app (ou subcategoria), crie uma nova ou ignore.",
  subcategory: "Subcategorias da planilha (com a categoria da mesma linha). Ligue a uma subcategoria ou categoria do app, crie ou ignore.",
  account: "Contas e bancos da planilha. Ligue a uma conta ou cartão do app, ou crie na hora.",
  card: "Cartões da planilha. Ligue a um cartão do app ou crie na hora (com os dias de fechamento e vencimento).",
  person: "Quem fez cada lançamento. Ligue a uma pessoa da família ou deixe sem pessoa.",
  nature: "Coluna PF/PJ da planilha: Pessoal, Empresa ou Repasse de cliente. A natureza só muda relatórios — saldos e faturas não mudam.",
};

/** Etapa 4: correspondências "De → Para" (o coração da migração), opções e "Gerar prévia". */
export function CorrespondencesStep({ migration: m, onBack }: { migration: MigrationDTO; onBack: () => void }) {
  const fields = CORRESPONDENCE_FIELDS.filter((f) => m.correspondences.some((c) => c.field === f));
  const [tab, setTab] = useState<CorrespondenceField | null>(fields.find((f) => m.pending[f] > 0) ?? fields[0] ?? null);
  const field = tab && fields.includes(tab) ? tab : (fields[0] ?? null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [creatingCategory, setCreatingCategory] = useState<Correspondence | null>(null);
  const [creatingDestination, setCreatingDestination] = useState<Correspondence | null>(null);

  const decide = useUpdateCorrespondences(m.id);
  const apply = useApplySuggestions(m.id);
  const ai = useSuggestWithAI(m.id);
  const preview = useGeneratePreview(m.id);
  const busy = useMigrationBusy(m.id);

  const ofField = useMemo(() => (field ? m.correspondences.filter((c) => c.field === field) : []), [m.correspondences, field]);
  const term = normalizeText(search);
  const visibleAll = ofField.filter((c) => FILTERS.find((f) => f.id === filter)!.test(c) && (!term || normalizeText(`${c.label} ${c.parentLabel ?? ""}`).includes(term)));
  const visible = visibleAll.slice(0, limit);
  const totalSuggestions = pendingSuggestions(m.correspondences);
  const fieldSuggestions = field ? pendingSuggestions(m.correspondences, field) : 0;
  const unresolvedCategories = m.correspondences.filter((c) => (c.field === "category" || c.field === "subcategory") && !c.decision).length;
  const pending = pendingTotal(m);

  const setDecision = (item: Correspondence, decision: CorrespondenceDecision | null) => decide.mutate([{ field: item.field, key: item.key, decision }]);
  const createFor = (item: Correspondence): (() => void) | null => {
    if (item.field === "category" || item.field === "subcategory") return () => setCreatingCategory(item);
    if (item.field === "account" || item.field === "card") return () => setCreatingDestination(item);
    return null;
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Correspondências (De → Para)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Diga a que corresponde, no app, cada nome que aparece na planilha. O app já sugere o que reconheceu; aceite, troque, crie ou ignore.{" "}
          {pending ? <strong className="text-foreground">{plural(pending, "item pendente", "itens pendentes")}.</strong> : "Tudo decidido."}
        </p>
      </div>

      {(totalSuggestions > 0 || m.aiAvailable) && (
        <Card className="flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="min-w-0 text-muted-foreground">
              {totalSuggestions > 0 ? (
                <>
                  <strong className="text-foreground">{plural(totalSuggestions, "sugestão pendente", "sugestões pendentes")}</strong> em todas as abas.{" "}
                </>
              ) : null}
              {m.aiAvailable && (
                <>
                  “Sugerir com IA” envia à IA configurada <strong className="text-foreground">só os nomes distintos das categorias</strong> ainda sem correspondência — nunca valores, datas ou
                  descrições.
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {m.aiAvailable && (
              <Button variant="outline" size="sm" onClick={() => ai.mutate()} loading={ai.isPending} disabled={busy || !unresolvedCategories} title={!unresolvedCategories ? "Não há categorias sem decisão" : undefined}>
                <Sparkles aria-hidden /> Sugerir com IA{unresolvedCategories ? ` (${unresolvedCategories})` : ""}
              </Button>
            )}
            {totalSuggestions > 0 && (
              <Button variant="brand" size="sm" onClick={() => apply.mutate(undefined)} loading={apply.isPending && !apply.variables} disabled={busy}>
                <CheckCheck aria-hidden /> Aplicar todas as sugestões ({totalSuggestions})
              </Button>
            )}
          </div>
        </Card>
      )}

      {!field ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Nenhum nome a corresponder: as abas escolhidas não têm colunas de categoria, conta, cartão, pessoa ou natureza. Confira as opções abaixo e gere a prévia.
        </Card>
      ) : (
        <Card className="p-0">
          <div className="space-y-3 border-b p-3 sm:p-4">
            <Tabs
              value={field}
              onValueChange={(v) => {
                setTab(v as CorrespondenceField);
                setLimit(PAGE);
              }}
            >
              <div className="relative -mx-1 overflow-x-auto px-1 pb-1">
                <TabsList className="h-auto w-max" aria-label="Tipo de correspondência">
                  {fields.map((f) => (
                    <TabsTrigger key={f} value={f}>
                      {CORRESPONDENCE_FIELD_LABELS[f]}
                      {m.pending[f] > 0 ? (
                        <>
                          <Badge variant="warning" className="px-1.5" aria-hidden>
                            {m.pending[f]}
                          </Badge>
                          <span className="sr-only">, {plural(m.pending[f], "pendente", "pendentes")}</span>
                        </>
                      ) : (
                        <>
                          <CheckCheck className="text-positive" aria-hidden />
                          <span className="sr-only">, tudo decidido</span>
                        </>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </Tabs>
            <p className="text-xs text-muted-foreground">{FIELD_HELP[field]}</p>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar itens">
                  {FILTERS.map((f) => {
                    const n = ofField.filter(f.test).length;
                    return (
                      <Button
                        key={f.id}
                        variant="outline"
                        size="sm"
                        aria-pressed={filter === f.id}
                        className={cn(filter === f.id && "border-brand bg-accent/60")}
                        onClick={() => {
                          setFilter(f.id);
                          setLimit(PAGE);
                        }}
                      >
                        {f.label} ({n})
                      </Button>
                    );
                  })}
                </div>
                <div className="relative w-full sm:w-56">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setLimit(PAGE);
                    }}
                    placeholder="Buscar nome"
                    className="h-8 pl-9 text-sm"
                    aria-label={`Buscar em ${CORRESPONDENCE_FIELD_LABELS[field]}`}
                  />
                </div>
              </div>
              {fieldSuggestions > 0 && (
                <Button variant="outline" size="sm" onClick={() => apply.mutate([field])} loading={apply.isPending && Boolean(apply.variables)} disabled={busy}>
                  <CheckCheck aria-hidden /> Aplicar sugestões de {CORRESPONDENCE_FIELD_LABELS[field]} ({fieldSuggestions})
                </Button>
              )}
            </div>
          </div>

          {!visible.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{filter === "PENDING" && !term ? "Nada pendente aqui." : "Nenhum item neste filtro."}</p>
          ) : (
            <ul className="divide-y" aria-label={CORRESPONDENCE_FIELD_LABELS[field]}>
              {visible.map((c) => (
                <CorrespondenceRow
                  key={`${c.field}:${c.key}`}
                  migration={m}
                  item={c}
                  showNewTag={Boolean(m.template)}
                  disabled={busy}
                  onDecide={(d) => setDecision(c, d)}
                  onCreate={createFor(c)}
                />
              ))}
            </ul>
          )}
          {visibleAll.length > visible.length && (
            <div className="flex items-center justify-between gap-2 border-t p-3 text-sm">
              <span className="text-muted-foreground tabular">
                {visible.length} de {visibleAll.length}
              </span>
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                Mostrar mais
              </Button>
            </div>
          )}
        </Card>
      )}

      <OptionsPanel migration={m} />

      <Card className="sticky bottom-20 z-10 flex flex-col gap-3 border-brand/30 p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between sm:p-4 lg:bottom-4">
        <div className="min-w-0 text-sm">
          {m.ready.canPreview ? (
            <p className="flex items-start gap-1.5">
              <ListChecks className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
              <span>
                <span className="font-semibold">Pronto para a prévia.</span>{" "}
                <span className="text-muted-foreground">
                  {pending ? `Ainda há ${plural(pending, "item sem decisão", "itens sem decisão")}; dá para gerar a prévia mesmo assim. ` : ""}Nada é gravado antes de “Importar tudo”.
                </span>
              </span>
            </p>
          ) : (
            <div className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="font-semibold">Falta pouco para a prévia:</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground" aria-label="O que falta para gerar a prévia">
                  {(m.ready.problems.length ? m.ready.problems : ["Confira abas, colunas e correspondências."]).map((p) => (
                    <li key={p} className="break-words">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onBack} disabled={preview.isPending}>
            <ArrowLeft aria-hidden /> Colunas
          </Button>
          <Button variant="brand" onClick={() => preview.mutate()} loading={preview.isPending} disabled={!m.ready.canPreview || busy} className="flex-1 sm:flex-none">
            <Eye aria-hidden /> Gerar prévia
          </Button>
        </div>
      </Card>

      <CreateCategoryDialog
        migration={m}
        item={creatingCategory}
        onOpenChange={(v) => !v && setCreatingCategory(null)}
        onSubmit={(item, decision) => setDecision(item, decision)}
      />
      <CreateDestinationDialog migration={m} item={creatingDestination} onOpenChange={(v) => !v && setCreatingDestination(null)} />
    </div>
  );
}

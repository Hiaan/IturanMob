"use client";

import { ArrowRight, Check, CircleDashed, CircleSlash, Plus, Sparkles, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Correspondence, CorrespondenceDecision, MigrationDTO } from "@/server/modules/migration/types";
import { IGNORE_HINTS, SOURCE_HINTS, SOURCE_LABELS, acceptDecision, isSuggestionDecision, itemAmounts, parentName, percent } from "./labels";
import { TARGET_ICONS, TargetPicker } from "./target-picker";

export function SuggestionBadge({ suggestion }: { suggestion: NonNullable<Correspondence["suggestion"]> }) {
  return (
    <Badge variant={suggestion.source === "AI" ? "info" : suggestion.source === "TEMPLATE" ? "brand" : "outline"} title={SOURCE_HINTS[suggestion.source]}>
      {suggestion.source === "AI" && <Sparkles aria-hidden />}
      {SOURCE_LABELS[suggestion.source]} · {percent(suggestion.confidence)}
    </Badge>
  );
}

/** Texto da decisão atual ("Para"). */
function DecisionView({ migration: m, item }: { migration: MigrationDTO; item: Correspondence }) {
  const d = item.decision;
  if (!d) {
    const s = item.suggestion;
    if (!s)
      return (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <CircleDashed className="size-4 shrink-0 text-warning" aria-hidden />
          <span>Sem sugestão — escolha, crie ou ignore</span>
        </p>
      );
    const Icon = TARGET_ICONS[s.targetType];
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <CircleDashed className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="text-muted-foreground">Sugestão:</span>
        <span className="inline-flex min-w-0 items-center gap-1 font-medium">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="break-words">{s.label}</span>
        </span>
        <SuggestionBadge suggestion={s} />
      </p>
    );
  }
  if (d.action === "MAP") {
    const Icon = TARGET_ICONS[d.targetType];
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <Check className="size-4 shrink-0 text-positive" aria-hidden />
        <span className="inline-flex min-w-0 items-center gap-1 font-medium">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="break-words">{d.label}</span>
        </span>
        {isSuggestionDecision(item) && item.suggestion ? <SuggestionBadge suggestion={item.suggestion} /> : <Badge variant="muted">escolhida</Badge>}
      </p>
    );
  }
  if (d.action === "CREATE") {
    const parent = parentName(m.targets, d.parentId);
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <Plus className="size-4 shrink-0 text-brand" aria-hidden />
        <span>
          Criar <strong className="break-words">“{d.name}”</strong>
          <span className="text-muted-foreground">
            {" "}
            ({d.kind === "INCOME" ? "receita" : "despesa"}
            {parent ? `, dentro de ${parent}` : ""})
          </span>
        </span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      <CircleSlash className="size-4 shrink-0" aria-hidden />
      <span>
        Ignorado — <span className="text-foreground">{IGNORE_HINTS[item.field]}</span>
      </span>
    </p>
  );
}

/** Um item "De → Para": como aparece na planilha, o destino escolhido/sugerido e as ações. */
export function CorrespondenceRow({
  migration: m,
  item,
  showNewTag,
  disabled,
  onDecide,
  onCreate,
}: {
  migration: MigrationDTO;
  item: Correspondence;
  /** A planilha veio de um formato salvo: itens fora dele ganham a etiqueta "novo". */
  showNewTag: boolean;
  disabled: boolean;
  onDecide: (decision: CorrespondenceDecision | null) => void;
  /** Abre "Criar nova" (categorias/subcategorias e contas/cartões). */
  onCreate: (() => void) | null;
}) {
  const d = item.decision;
  const accept = acceptDecision(item);
  const current = d?.action === "MAP" ? { targetType: d.targetType, targetId: d.targetId } : null;
  const pending = !d;

  return (
    <li className={cn("flex flex-col gap-3 p-3 sm:p-4 xl:flex-row xl:items-center", pending && "bg-warning/5 shadow-[inset_3px_0_0_var(--color-warning)]")}>
      <div className="min-w-0 xl:w-[32%] xl:shrink-0">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="break-words font-medium">{item.label}</span>
          {item.parentLabel && <span className="text-xs text-muted-foreground">em {item.parentLabel}</span>}
          {item.fromTemplate ? <Badge variant="outline">do formato salvo</Badge> : showNewTag ? <Badge variant="warning">novo</Badge> : null}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground tabular">{itemAmounts(item)}</p>
      </div>

      <div className="flex min-w-0 flex-1 items-start gap-2">
        <ArrowRight className="mt-0.5 hidden size-4 shrink-0 text-muted-foreground xl:block" aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="sr-only">Para: </span>
          <DecisionView migration={m} item={item} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 xl:shrink-0 xl:justify-end">
        {accept && !isSuggestionDecision(item) && (
          <Button variant="outline" size="sm" className="border-brand/40" onClick={() => onDecide(accept)} disabled={disabled} aria-label={`Aceitar a sugestão para “${item.label}”`}>
            <Check aria-hidden /> Aceitar
          </Button>
        )}
        <TargetPicker
          field={item.field}
          targets={m.targets}
          kindHint={item.kindHint}
          current={current}
          onPick={(o) => onDecide({ action: "MAP", targetType: o.targetType, targetId: o.id, label: o.label })}
          disabled={disabled}
          itemLabel={item.label}
          triggerLabel={accept || d ? "Escolher outra" : "Escolher"}
        />
        {onCreate && (
          <Button variant="outline" size="sm" onClick={onCreate} disabled={disabled} aria-label={`Criar nova para “${item.label}”`}>
            <Plus aria-hidden /> Criar nova
          </Button>
        )}
        {d?.action !== "IGNORE" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDecide({ action: "IGNORE" })}
            disabled={disabled}
            title={`Ignorar: ${IGNORE_HINTS[item.field]}`}
            aria-label={`Ignorar “${item.label}” (${IGNORE_HINTS[item.field]})`}
          >
            <CircleSlash aria-hidden /> Ignorar
          </Button>
        )}
        {d && (
          <Button variant="ghost" size="sm" onClick={() => onDecide(null)} disabled={disabled} aria-label={`Desfazer a decisão de “${item.label}”`} title="Volta a ficar pendente">
            <Undo2 aria-hidden /> Desfazer
          </Button>
        )}
      </div>
    </li>
  );
}

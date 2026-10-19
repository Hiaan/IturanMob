"use client";

import { useMemo, useState } from "react";
import { Briefcase, Check, ChevronsUpDown, CreditCard, Landmark, Tag, Tags, User, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACCOUNT_TYPE_LABELS, labelOf } from "@/lib/labels";
import { normalizeText } from "@/lib/utils";
import type { Correspondence, CorrespondenceField, MigrationTargetsDTO, TargetType } from "@/server/modules/migration/types";
import { NATURE_TARGETS } from "./labels";

export interface TargetOption {
  targetType: TargetType;
  id: string;
  label: string;
  hint?: string;
}

interface TargetGroup {
  label: string;
  options: TargetOption[];
}

export const TARGET_ICONS: Record<TargetType, LucideIcon> = {
  CATEGORY: Tag,
  SUBCATEGORY: Tags,
  ACCOUNT: Landmark,
  CARD: CreditCard,
  MEMBER: User,
  NATURE: Briefcase,
};

/** Destinos possíveis de cada campo: categorias (com subcategorias), contas e cartões, pessoas, natureza. */
export function targetGroups(field: CorrespondenceField, targets: MigrationTargetsDTO, kindHint: Correspondence["kindHint"]): TargetGroup[] {
  const cards: TargetGroup = { label: "Cartões", options: targets.cards.map((c) => ({ targetType: "CARD", id: c.id, label: c.name })) };
  switch (field) {
    case "category":
    case "subcategory": {
      const ofKind = (kind: "EXPENSE" | "INCOME"): TargetOption[] =>
        targets.categories
          .filter((c) => c.kind === kind)
          .flatMap((c) => [
            { targetType: "CATEGORY" as const, id: c.id, label: c.name },
            ...c.subcategories.map((s) => ({ targetType: "SUBCATEGORY" as const, id: s.id, label: `${c.name} › ${s.name}` })),
          ]);
      const groups: TargetGroup[] = [
        { label: "Despesas", options: ofKind("EXPENSE") },
        { label: "Receitas", options: ofKind("INCOME") },
      ];
      return kindHint === "INCOME" ? groups.reverse() : groups;
    }
    case "account":
      return [
        {
          label: "Contas",
          options: targets.accounts.map((a) => ({
            targetType: "ACCOUNT",
            id: a.id,
            label: a.name,
            hint: [labelOf(ACCOUNT_TYPE_LABELS, a.type, a.type), a.institution].filter(Boolean).join(" · "),
          })),
        },
        cards,
      ];
    case "card":
      return [cards];
    case "person":
      return [{ label: "Pessoas da família", options: targets.members.map((m) => ({ targetType: "MEMBER", id: m.id, label: m.name })) }];
    case "nature":
      return [{ label: "Natureza", options: NATURE_TARGETS.map((n) => ({ targetType: "NATURE", id: n.id, label: n.label })) }];
  }
}

/** "Escolher outra": lista pesquisável dos destinos do campo. */
export function TargetPicker({
  field,
  targets,
  kindHint,
  current,
  onPick,
  disabled,
  itemLabel,
  triggerLabel = "Escolher outra",
}: {
  field: CorrespondenceField;
  targets: MigrationTargetsDTO;
  kindHint: Correspondence["kindHint"];
  current: { targetType: TargetType; targetId: string } | null;
  onPick: (option: TargetOption) => void;
  disabled?: boolean;
  itemLabel: string;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const groups = useMemo(() => targetGroups(field, targets, kindHint), [field, targets, kindHint]);
  const term = normalizeText(search);
  const filtered = groups
    .map((g) => ({ ...g, options: term ? g.options.filter((o) => normalizeText(o.label).includes(term) || normalizeText(o.hint ?? "").includes(term)) : g.options }))
    .filter((g) => g.options.length);
  const total = groups.reduce((s, g) => s + g.options.length, 0);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label={`${triggerLabel} para “${itemLabel}”`}>
          <ChevronsUpDown aria-hidden /> {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false} label={`Destino para ${itemLabel}`}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Buscar…" />
          <CommandList className="max-h-72">
            <CommandEmpty>{total ? "Nada encontrado." : "Nenhuma opção cadastrada no app — use “Criar nova”."}</CommandEmpty>
            {filtered.map((g) => (
              <CommandGroup key={g.label} heading={g.label}>
                {g.options.map((o) => {
                  const Icon = TARGET_ICONS[o.targetType];
                  const selected = current?.targetType === o.targetType && current.targetId === o.id;
                  return (
                    <CommandItem
                      key={`${o.targetType}:${o.id}`}
                      value={`${o.targetType}:${o.id}`}
                      onSelect={() => {
                        onPick(o);
                        setOpen(false);
                        setSearch("");
                      }}
                    >
                      <Icon aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{o.label}</span>
                        {o.hint && <span className="block truncate text-xs text-muted-foreground">{o.hint}</span>}
                      </span>
                      {selected && (
                        <>
                          <Check className="ml-auto" aria-hidden />
                          <span className="sr-only">(escolhida)</span>
                        </>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

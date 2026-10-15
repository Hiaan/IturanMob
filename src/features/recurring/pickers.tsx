"use client";

import { useMemo } from "react";
import { CreditCard, Landmark } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAccounts, useCards, useCategories } from "@/features/finance/hooks";

export const NONE = "__none__";

/** Valor do seletor de categoria: "cat:<id>", "sub:<id>" ou NONE. */
export function categoryValue(categoryId: string | null | undefined, subcategoryId?: string | null): string {
  if (subcategoryId) return `sub:${subcategoryId}`;
  if (categoryId) return `cat:${categoryId}`;
  return NONE;
}

export function parseCategoryValue(v: string | undefined): { categoryId: string | null; subcategoryId: string | null } {
  if (v?.startsWith("sub:")) return { categoryId: null, subcategoryId: v.slice(4) };
  if (v?.startsWith("cat:")) return { categoryId: v.slice(4), subcategoryId: null };
  return { categoryId: null, subcategoryId: null };
}

export function CategoryPicker({
  id,
  value,
  onChange,
  kind,
  withSubcategories = true,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  kind: "EXPENSE" | "INCOME";
  withSubcategories?: boolean;
}) {
  const categories = useCategories();
  const options = useMemo(() => (categories.data ?? []).filter((c) => c.kind === kind && !c.archivedAt), [categories.data, kind]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Sem categoria" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Sem categoria</SelectItem>
        {withSubcategories
          ? options.map((c) => (
              <SelectGroup key={c.id}>
                <SelectLabel className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                  {c.name}
                </SelectLabel>
                <SelectItem value={`cat:${c.id}`}>{c.name} (geral)</SelectItem>
                {c.subcategories
                  .filter((s) => !s.archivedAt)
                  .map((s) => (
                    <SelectItem key={s.id} value={`sub:${s.id}`}>
                      {c.name} › {s.name}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))
          : options.map((c) => (
              <SelectItem key={c.id} value={`cat:${c.id}`}>
                {c.name}
              </SelectItem>
            ))}
      </SelectContent>
    </Select>
  );
}

/** Alternância "Conta" / "Cartão de crédito". */
export function PayWithToggle({ value, onChange, disabledCard }: { value: "account" | "card"; onChange: (v: "account" | "card") => void; disabledCard?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Pagar com">
      {(
        [
          ["account", "Conta", Landmark],
          ["card", "Cartão de crédito", CreditCard],
        ] as const
      ).map(([v, label, Icon]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={v === "card" && disabledCard}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition disabled:opacity-40",
            value === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden /> {label}
        </button>
      ))}
    </div>
  );
}

export function AccountSelect({ id, value, onChange, noneLabel = "Sem conta" }: { id?: string; value: string; onChange: (v: string) => void; noneLabel?: string }) {
  const accounts = useAccounts();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={noneLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{noneLabel}</SelectItem>
        {(accounts.data ?? []).map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CardSelect({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  const cards = useCards();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Selecione o cartão" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Selecione…</SelectItem>
        {(cards.data ?? []).map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

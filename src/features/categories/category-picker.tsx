"use client";

import { useMemo } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCategories } from "@/features/finance/hooks";
import type { CategoryDTO } from "@/features/finance/types";

export interface CategoryChoice {
  categoryId: string;
  subcategoryId: string | null;
}

const NONE = "__none__";

export function encodeChoice(c: CategoryChoice | null): string {
  if (!c) return NONE;
  return c.subcategoryId ? `sub:${c.categoryId}:${c.subcategoryId}` : `cat:${c.categoryId}`;
}

export function decodeChoice(v: string): CategoryChoice | null {
  if (v.startsWith("sub:")) {
    const [, categoryId, subcategoryId] = v.split(":");
    return categoryId && subcategoryId ? { categoryId, subcategoryId } : null;
  }
  if (v.startsWith("cat:")) return { categoryId: v.slice(4), subcategoryId: null };
  return null;
}

/** Seletor de categoria + subcategoria (agrupado por categoria, com cor). */
export function CategoryPicker({
  value,
  onChange,
  kind,
  id,
  allowNone,
  noneLabel = "Sem categoria",
  placeholder = "Selecione a categoria",
  excludeCategoryId,
  categoriesOnly,
  invalid,
  className,
}: {
  value: CategoryChoice | null;
  onChange: (value: CategoryChoice | null) => void;
  kind?: "EXPENSE" | "INCOME" | null;
  id?: string;
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
  excludeCategoryId?: string;
  categoriesOnly?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const categories = useCategories();
  const options = useMemo(
    () => (categories.data ?? []).filter((c) => !c.archivedAt && (!kind || c.kind === kind) && c.id !== excludeCategoryId),
    [categories.data, kind, excludeCategoryId],
  );
  const groups: Array<[string, CategoryDTO[]]> = kind
    ? [[kind === "INCOME" ? "Receitas" : "Despesas", options]]
    : [
        ["Despesas", options.filter((c) => c.kind === "EXPENSE")],
        ["Receitas", options.filter((c) => c.kind === "INCOME")],
      ];
  return (
    <Select value={value ? encodeChoice(value) : allowNone ? NONE : ""} onValueChange={(v) => onChange(decodeChoice(v))}>
      <SelectTrigger id={id} aria-invalid={invalid || undefined} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {groups.map(([label, list], gi) =>
          list.length ? (
            <SelectGroup key={label}>
              {(gi > 0 || allowNone) && <SelectSeparator />}
              {!kind && <SelectLabel>{label}</SelectLabel>}
              {list.map((c) => (
                <SelectGroupItems key={c.id} category={c} categoriesOnly={categoriesOnly} />
              ))}
            </SelectGroup>
          ) : null,
        )}
      </SelectContent>
    </Select>
  );
}

function SelectGroupItems({ category: c, categoriesOnly }: { category: CategoryDTO; categoriesOnly?: boolean }) {
  return (
    <>
      <SelectItem value={`cat:${c.id}`}>
        <span className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
          {c.name}
        </span>
      </SelectItem>
      {!categoriesOnly &&
        c.subcategories
          .filter((s) => !s.archivedAt)
          .map((s) => (
            <SelectItem key={s.id} value={`sub:${c.id}:${s.id}`} className="pl-12">
              {c.name} › {s.name}
            </SelectItem>
          ))}
    </>
  );
}

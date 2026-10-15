"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn, normalizeText } from "@/lib/utils";

/**
 * Editor de palavras-chave em "chips". As palavras são normalizadas como no servidor
 * (minúsculas, sem acentos) para que o usuário veja exatamente o que será salvo.
 */
export function KeywordEditor({
  keywords,
  onChange,
  inputId,
  disabled,
  compact,
}: {
  keywords: string[];
  onChange: (next: string[]) => void;
  inputId?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((p) => normalizeText(p))
      .filter((p) => p.length > 0 && p.length <= 60);
    if (!parts.length) return;
    const next = [...new Set([...keywords, ...parts])].slice(0, 60);
    if (next.length !== keywords.length) onChange(next);
    setDraft("");
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card p-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25", disabled && "opacity-60")}>
      {keywords.map((k) => (
        <span key={k} className="inline-flex h-6 items-center gap-0.5 rounded-md bg-muted pl-2 pr-0.5 text-xs">
          {k}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(keywords.filter((x) => x !== k))}
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={`Remover palavra-chave ${k}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <span className="flex min-w-[140px] flex-1 items-center">
        <input
          id={inputId}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) add(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && keywords.length) {
              onChange(keywords.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={keywords.length ? "Adicionar…" : "Ex.: racao, petshop"}
          aria-label="Adicionar palavra-chave"
          className={cn("h-6 w-full min-w-0 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground/70", compact && "text-xs")}
          maxLength={120}
        />
        {draft.trim() && (
          <button type="button" onClick={() => add(draft)} className="rounded p-0.5 text-brand hover:bg-muted" aria-label="Adicionar palavra-chave digitada">
            <Plus className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}

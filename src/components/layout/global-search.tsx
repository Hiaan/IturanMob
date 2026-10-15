"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Landmark, Tag, Target } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { ALL_NAV_ITEMS } from "./nav";
import type { TransactionDTO } from "@/features/finance/types";

interface SearchResult {
  transactions: TransactionDTO[];
  accounts: Array<{ id: string; name: string; color: string }>;
  cards: Array<{ id: string; name: string; color: string }>;
  categories: Array<{ id: string; name: string; color: string; kind: string }>;
  goals: Array<{ id: string; name: string; color: string }>;
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const debounced = useDebounced(term.trim(), 250);
  const { data, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchResult>(`/api/v1/search?term=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });

  const go = (href: string) => {
    onOpenChange(false);
    setTerm("");
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 overflow-hidden p-0" hideClose>
        <DialogTitle className="sr-only">Busca global</DialogTitle>
        <Command shouldFilter={false}>
          <CommandInput placeholder="Buscar transações, valores, categorias, contas…" value={term} onValueChange={setTerm} />
          <CommandList>
            {debounced.length < 2 ? (
              <CommandGroup heading="Ir para">
                {ALL_NAV_ITEMS.map((item) => (
                  <CommandItem key={item.href} value={item.href} onSelect={() => go(item.href)}>
                    <item.icon />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <>
                {!isFetching && <CommandEmpty>Nada encontrado para “{debounced}”.</CommandEmpty>}
                {data?.transactions.length ? (
                  <CommandGroup heading="Transações">
                    {data.transactions.map((t) => (
                      <CommandItem key={t.id} value={`tx-${t.id}`} onSelect={() => go(`/transacoes?id=${t.id}`)}>
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: t.category?.color ?? "#94a3b8" }} />
                        <span className="flex-1 truncate">{t.description}</span>
                        <span className="text-xs text-muted-foreground">{formatDateBR(t.date)}</span>
                        <span className="w-24 text-right text-sm font-medium tabular">{formatBRL(t.amountCents)}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {data?.categories.length ? (
                  <CommandGroup heading="Categorias">
                    {data.categories.map((c) => (
                      <CommandItem key={c.id} value={`cat-${c.id}`} onSelect={() => go(`/transacoes?categoryId=${c.id}`)}>
                        <Tag />
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {data?.accounts.length ? (
                  <CommandGroup heading="Contas">
                    {data.accounts.map((a) => (
                      <CommandItem key={a.id} value={`acc-${a.id}`} onSelect={() => go(`/contas?id=${a.id}`)}>
                        <Landmark />
                        {a.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {data?.cards.length ? (
                  <CommandGroup heading="Cartões">
                    {data.cards.map((c) => (
                      <CommandItem key={c.id} value={`card-${c.id}`} onSelect={() => go(`/cartoes?id=${c.id}`)}>
                        <CreditCard />
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {data?.goals.length ? (
                  <CommandGroup heading="Metas">
                    {data.goals.map((g) => (
                      <CommandItem key={g.id} value={`goal-${g.id}`} onSelect={() => go(`/metas`)}>
                        <Target />
                        {g.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

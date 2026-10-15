"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { AccountDTO, CardDTO, CategoryDTO, MemberDTO } from "./types";

export function useAccounts(opts: { includeArchived?: boolean } = {}) {
  return useQuery({ queryKey: qk.accounts(opts), queryFn: () => api.get<AccountDTO[]>("/api/v1/accounts", opts.includeArchived ? { includeArchived: true } : undefined) });
}

export function useCards(opts: { includeArchived?: boolean } = {}) {
  return useQuery({ queryKey: qk.cards(opts), queryFn: () => api.get<CardDTO[]>("/api/v1/cards", opts.includeArchived ? { includeArchived: true } : undefined) });
}

export function useCategories(opts: { includeArchived?: boolean } = {}) {
  return useQuery({
    queryKey: qk.categories(opts),
    queryFn: () => api.get<CategoryDTO[]>("/api/v1/categories", opts.includeArchived ? { includeArchived: true } : undefined),
    staleTime: 5 * 60_000,
  });
}

export function useMembers() {
  return useQuery({ queryKey: qk.members, queryFn: () => api.get<MemberDTO[]>("/api/v1/members"), staleTime: 5 * 60_000 });
}

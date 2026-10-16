"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";

export interface MeResponse {
  user: { id: string; name: string; email: string };
  member: { id: string; displayName: string; role: string; color: string };
  household: { id: string; name: string; timezone: string };
  permissions: string[];
  canViewOthersPrivate: boolean;
  pending: { total: number; byType: Record<string, number> };
}

const noopSubscribe = () => () => {};

/** `false` enquanto o React hidrata o HTML do servidor; `true` depois (e em telas montadas no cliente). */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/**
 * Dados da pessoa logada. Durante a hidratação devolve `data` vazio, como no HTML do servidor:
 * o conteúdo da página chega depois do menu (carregamento em streaming) e, nesse meio-tempo, o menu
 * já pode ter buscado /me — sem isso, botões que dependem de permissão divergiriam do servidor.
 */
export function useMe() {
  const query = useQuery({ queryKey: qk.me, queryFn: () => api.get<MeResponse>("/api/v1/me"), staleTime: 60_000 });
  const hydrated = useHydrated();
  return hydrated ? query : ({ ...query, data: undefined } as typeof query);
}

export function useCan(permission: string): boolean {
  const { data } = useMe();
  return Boolean(data?.permissions.includes(permission));
}

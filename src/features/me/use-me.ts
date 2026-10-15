"use client";

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

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => api.get<MeResponse>("/api/v1/me"), staleTime: 60_000 });
}

export function useCan(permission: string): boolean {
  const { data } = useMe();
  return Boolean(data?.permissions.includes(permission));
}

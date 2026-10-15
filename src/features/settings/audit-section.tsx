"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { api } from "@/lib/client/api";
import { formatDateTimeBR } from "@/lib/dates";

interface AuditItem {
  id: string;
  action: string;
  actorType: string;
  actorName: string | null;
  entityType: string;
  entityId: string | null;
  source: string | null;
  createdAt: string;
}

const ACTIONS: Record<string, string> = {
  CREATE: "Criação",
  UPDATE: "Edição",
  DELETE: "Exclusão",
  RESTORE: "Restauração",
  RECLASSIFY: "Reclassificação",
  CONFIRM: "Confirmação",
  REJECT: "Rejeição",
  LOGIN: "Login",
  LOGIN_FAILED: "Login falhou",
  LOGOUT: "Logout",
  IMPORT: "Importação",
  UNDO_IMPORT: "Importação desfeita",
  SETTINGS_CHANGE: "Configuração",
  EXPORT: "Exportação/acesso",
  PURGE: "Exclusão definitiva",
  CONNECT: "Conexão",
  DISCONNECT: "Desconexão",
};

const ENTITIES: Record<string, string> = {
  Transaction: "Transação",
  Account: "Conta",
  CreditCard: "Cartão",
  Category: "Categoria",
  Subcategory: "Subcategoria",
  FinancialRule: "Regra",
  HouseholdMember: "Membro",
  Household: "Família",
  HouseholdSettings: "Configurações",
  Invitation: "Convite",
  User: "Usuário",
  Budget: "Orçamento",
  FinancialGoal: "Meta",
  Attachment: "Anexo",
};

const ACTORS: Record<string, string> = { USER: "pelo painel", AI: "pela IA", SYSTEM: "pelo sistema", WHATSAPP: "pelo WhatsApp", IMPORT: "por importação" };

export function AuditSection() {
  const q = useInfiniteQuery({
    queryKey: ["audit", "list"],
    queryFn: ({ pageParam }) => api.get<{ items: AuditItem[]; nextCursor: string | null }>("/api/v1/audit", { limit: 50, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trilha de auditoria</CardTitle>
        <CardDescription>Todas as alterações relevantes, com autor, origem e horário.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-64" />
        ) : !items.length ? (
          <EmptyState icon={History} title="Sem registros" />
        ) : (
          <>
            <ul className="divide-y">
              {items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <Badge variant={i.action === "DELETE" || i.action === "PURGE" || i.action === "LOGIN_FAILED" ? "warning" : "muted"}>{ACTIONS[i.action] ?? i.action}</Badge>
                  <span className="font-medium">{ENTITIES[i.entityType] ?? i.entityType}</span>
                  <span className="text-muted-foreground">
                    {i.actorName ?? "Sistema"} {ACTORS[i.actorType] ?? ""}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground tabular">{formatDateTimeBR(i.createdAt)}</span>
                </li>
              ))}
            </ul>
            {q.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

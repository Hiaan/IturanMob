"use client";

import Link from "next/link";
import { CheckCircle2, Circle, CreditCard, Landmark, MessageCircle, UserPlus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccounts, useCards, useMembers } from "@/features/finance/hooks";

/** Checklist de primeiros passos (some quando tudo estiver configurado). */
export function OnboardingChecklist() {
  const accounts = useAccounts();
  const cards = useCards();
  const members = useMembers();
  if (accounts.isLoading || cards.isLoading || members.isLoading) return null;
  const steps = [
    { done: (accounts.data?.length ?? 0) > 0, label: "Cadastrar contas bancárias e carteira", href: "/contas", icon: Landmark },
    { done: (cards.data?.length ?? 0) > 0, label: "Cadastrar cartões de crédito (fechamento e vencimento)", href: "/cartoes", icon: CreditCard },
    { done: (members.data ?? []).filter((m) => m.hasLogin).length > 1, label: "Convidar o cônjuge", href: "/configuracoes?tab=membros", icon: UserPlus },
    { done: (members.data ?? []).some((m) => m.whatsappAuthorized && m.whatsappConsentAt), label: "Conectar o WhatsApp e autorizar os participantes", href: "/integracoes/whatsapp", icon: MessageCircle },
  ];
  if (steps.every((s) => s.done)) return null;
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <Card className="border-brand/25 bg-gradient-to-br from-accent/60 to-card">
      <CardHeader>
        <CardTitle>Primeiros passos</CardTitle>
        <CardDescription>
          {doneCount} de {steps.length} concluídos. Complete a configuração para aproveitar o registro automático.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {steps.map((s) => (
            <li key={s.href}>
              <Link href={s.href} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm transition hover:border-brand/40">
                {s.done ? <CheckCircle2 className="size-5 text-positive" /> : <Circle className="size-5 text-muted-foreground" />}
                <s.icon className="size-4 text-muted-foreground" />
                <span className={s.done ? "text-muted-foreground line-through" : "font-medium"}>{s.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

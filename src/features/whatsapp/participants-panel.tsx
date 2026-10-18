"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, Clock, ExternalLink, Fingerprint, Phone, ShieldCheck, UserX } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTimeBR } from "@/lib/dates";
import { useMembers } from "@/features/finance/hooks";
import { useOwnConsent } from "./hooks";
import type { WaStatus } from "./types";
import { formatPhone, initials } from "./utils";

export function ParticipantsPanel({ status, timezone }: { status: WaStatus; timezone?: string }) {
  const members = useMembers();
  const consent = useOwnConsent();
  const [consentFor, setConsentFor] = useState<{ id: string; give: boolean } | null>(null);
  const extra = new Map((members.data ?? []).map((m) => [m.id, m]));
  const ready = status.members.filter((m) => m.ready);
  const missingConsent = status.members.filter((m) => m.whatsappAuthorized && !m.hasConsent);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Participantes autorizados</CardTitle>
        <CardDescription>
          Só são processadas mensagens de membros com número cadastrado, autorizados por um administrador e que deram o próprio consentimento.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={ready.length ? "positive" : "warning"}>
            {ready.length ? <CheckCircle2 aria-hidden /> : <CircleAlert aria-hidden />}
            {ready.length} de {status.members.length} pronto{status.members.length === 1 ? "" : "s"}
          </Badge>
          {missingConsent.length > 0 && (
            <span className="text-warning">
              Sem consentimento: {missingConsent.map((m) => m.displayName).join(", ")}
            </span>
          )}
        </div>
        <ul className="divide-y rounded-xl border">
          {status.members.map((m) => {
            const info = extra.get(m.id);
            const isMe = Boolean(info?.isMe);
            return (
              <li key={m.id} className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                    style={{ backgroundColor: info?.color ?? "#5a6a82" }}
                    aria-hidden
                  >
                    {initials(m.displayName)}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                      <span className="truncate">{m.displayName}</span>
                      {isMe && <span className="text-xs font-normal text-muted-foreground">(você)</span>}
                      {m.relation && <span className="text-xs font-normal text-muted-foreground">{m.relation}</span>}
                    </p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone className="size-3" aria-hidden />
                      {m.whatsappPhone ? <span className="tabular">{formatPhone(m.whatsappPhone)}</span> : <span className="text-warning">Sem número cadastrado</span>}
                      {m.identified && (
                        <span className="ml-1 inline-flex items-center gap-0.5" title="Identificado nas mensagens do WhatsApp">
                          <Fingerprint className="size-3" aria-hidden /> identificado
                        </span>
                      )}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {m.whatsappAuthorized ? (
                        <Badge variant="positive">
                          <ShieldCheck aria-hidden /> Autorizado
                        </Badge>
                      ) : (
                        <Badge variant="muted">
                          <UserX aria-hidden /> Não autorizado
                        </Badge>
                      )}
                      {m.hasConsent ? (
                        <Badge variant="positive">
                          <CheckCircle2 aria-hidden /> Consentiu em {formatDateTimeBR(m.whatsappConsentAt, timezone)}
                        </Badge>
                      ) : (
                        <Badge variant="warning">
                          <Clock aria-hidden /> Consentimento pendente
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                {isMe && m.whatsappPhone && (
                  <div className="sm:pl-2">
                    {m.hasConsent ? (
                      <Button size="sm" variant="ghost" onClick={() => setConsentFor({ id: m.id, give: false })}>
                        Revogar meu consentimento
                      </Button>
                    ) : (
                      <Button size="sm" variant="brand" onClick={() => setConsentFor({ id: m.id, give: true })}>
                        Dar meu consentimento
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      <CardFooter className="flex-col items-start justify-between gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center">
        <span>O consentimento só pode ser dado pelo próprio participante.</span>
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link href="/configuracoes?tab=membros">
            Editar em Configurações › Membros <ExternalLink aria-hidden />
          </Link>
        </Button>
      </CardFooter>

      <Dialog open={Boolean(consentFor)} onOpenChange={(o) => !o && setConsentFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{consentFor?.give ? "Consentimento para processar suas mensagens" : "Revogar consentimento"}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                {consentFor?.give ? (
                  <>
                    <p>Ao consentir, as mensagens que você enviar nos grupos autorizados da família serão lidas pelo Finance AI para registrar gastos, receitas e responder consultas.</p>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>Somente os grupos autorizados são processados; outras conversas não são lidas nem armazenadas.</li>
                      <li>Áudios e comprovantes ficam guardados criptografados pelo período de retenção configurado.</li>
                      <li>Você pode revogar a qualquer momento.</li>
                    </ul>
                  </>
                ) : (
                  <p>Suas próximas mensagens deixarão de ser processadas. O que já foi registrado continua disponível.</p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsentFor(null)}>
              Cancelar
            </Button>
            <Button
              variant={consentFor?.give ? "brand" : "destructive"}
              loading={consent.isPending}
              onClick={() => {
                if (!consentFor) return;
                consent.mutate({ memberId: consentFor.id, consent: consentFor.give }, { onSettled: () => setConsentFor(null) });
              }}
            >
              {consentFor?.give ? "Concordo" : "Revogar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

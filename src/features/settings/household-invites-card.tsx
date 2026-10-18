"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Clock, Copy, HousePlus, Link2, LockKeyhole, Share2, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";

type InviteStatus = "ACTIVE" | "USED" | "EXPIRED" | "REVOKED";

interface HouseholdInvite {
  id: string;
  label: string | null;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdHouseholdName: string | null;
}

interface HouseholdInviteList {
  canInvite: boolean;
  ttlDays: number;
  items: HouseholdInvite[];
}

type CreatedInvite = HouseholdInvite & { url: string; warning?: string | null };

const STATUS: Record<InviteStatus, { label: string; variant: "positive" | "info" | "muted" | "warning" }> = {
  ACTIVE: { label: "Ativo", variant: "positive" },
  USED: { label: "Usado", variant: "info" },
  EXPIRED: { label: "Expirado", variant: "muted" },
  REVOKED: { label: "Revogado", variant: "warning" },
};

const MAX_LABEL = 80;

/** Copia o texto; sem a API de área de transferência (HTTP, permissões), seleciona o campo e usa o comando antigo. */
async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // cai no método alternativo
  }
  if (!input) return false;
  input.focus();
  input.select();
  input.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function InviteDates({ invite, tz }: { invite: HouseholdInvite; tz?: string }) {
  const created = `Gerado em ${formatDateTimeBR(invite.createdAt, tz)}`;
  if (invite.status === "USED") {
    return (
      <>
        {created} · usado em {formatDateTimeBR(invite.usedAt, tz)}
        {invite.createdHouseholdName && (
          <span className="block text-foreground/80">
            Criou a família <strong className="font-medium text-foreground">{invite.createdHouseholdName}</strong>
          </span>
        )}
      </>
    );
  }
  if (invite.status === "REVOKED") return <>{`${created} · revogado em ${formatDateTimeBR(invite.revokedAt, tz)}`}</>;
  if (invite.status === "EXPIRED") return <>{`${created} · expirou em ${formatDateTimeBR(invite.expiresAt, tz)}`}</>;
  return <>{`${created} · vale até ${formatDateTimeBR(invite.expiresAt, tz)}`}</>;
}

/**
 * "Convidar nova família": só para o administrador da instalação (quem não é recebe `canInvite: false`
 * e o cartão não aparece). O link cria UMA família nova e separada; o cadastro público continua fechado.
 */
export function HouseholdInvitesCard({ className }: { className?: string }) {
  const qc = useQueryClient();
  const tz = useMe().data?.household.timezone;
  const invites = useQuery({ queryKey: qk.householdInvites, queryFn: () => api.get<HouseholdInviteList>("/api/v1/instance/invites"), staleTime: 60_000 });
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [revoking, setRevoking] = useState<HouseholdInvite | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  const create = useMutation({
    mutationFn: (input: { label: string | null }) => api.post<CreatedInvite>("/api/v1/instance/invites", input),
    onSuccess: (res) => {
      setCreated(res);
      setCopied(false);
      setLabel("");
      toast.success("Link de convite gerado", { description: "Copie ou compartilhe agora: ele não aparece de novo." });
      qc.invalidateQueries({ queryKey: qk.householdInvites });
    },
    onError: (e) => setFormError(e instanceof ApiError && e.issues?.[0] ? e.issues[0].message : errorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete<HouseholdInvite>(`/api/v1/instance/invites/${id}`),
    onSuccess: (res) => {
      toast.success("Convite revogado", { description: res.label ? `O link de “${res.label}” não funciona mais.` : "O link não funciona mais." });
      if (created?.id === res.id) setCreated(null);
      setRevoking(null);
      qc.invalidateQueries({ queryKey: qk.householdInvites });
    },
    onError: (e) => {
      setRevokeError(errorMessage(e));
      qc.invalidateQueries({ queryKey: qk.householdInvites });
    },
  });

  if (!invites.data?.canInvite) return null;
  const { items, ttlDays } = invites.data;
  const activeCount = items.filter((i) => i.status === "ACTIVE").length;

  const copy = async () => {
    if (!created) return;
    if (await copyText(created.url, linkRef.current)) {
      setCopied(true);
      toast.success("Link copiado");
    } else {
      linkRef.current?.focus();
      linkRef.current?.select();
      toast.info("Não foi possível copiar automaticamente", { description: "O link está selecionado: copie pelo menu do navegador." });
    }
  };

  const share = async () => {
    if (!created) return;
    try {
      await navigator.share({
        title: "Convite para o Finance AI",
        text: `Use este link para criar a sua família no Finance AI. Ele vale por ${ttlDays} dias e serve para um único cadastro.`,
        url: created.url,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast.error("Não foi possível compartilhar", { description: "Use “Copiar” e envie o link por onde preferir." });
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HousePlus className="size-4 text-brand" aria-hidden /> Convidar nova família
        </CardTitle>
        <CardDescription>Para outra família usar o Finance AI nesta instalação, com uma conta própria. Só a administração da instalação vê esta opção.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
          <li className="flex gap-2 rounded-lg bg-muted/40 p-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            <span>
              Cria <strong className="font-medium text-foreground">uma família nova e separada</strong>: dados, membros e WhatsApp próprios. Ninguém de uma família vê os dados da outra.
            </span>
          </li>
          <li className="flex gap-2 rounded-lg bg-muted/40 p-3">
            <Clock className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            <span>
              Vale por <strong className="font-medium text-foreground">{ttlDays} dias</strong> e serve para <strong className="font-medium text-foreground">um único cadastro</strong>.
            </span>
          </li>
          <li className="flex gap-2 rounded-lg bg-muted/40 p-3">
            <LockKeyhole className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            <span>O cadastro público continua fechado: só cria uma família quem recebe um link.</span>
          </li>
        </ul>

        <form
          className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            create.mutate({ label: label.trim() || null });
          }}
        >
          <Field label="Para quem?" htmlFor="hh-invite-label" error={formError ?? undefined} hint="Opcional — só para você lembrar a quem enviou.">
            <Input
              id="hh-invite-label"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (formError) setFormError(null);
              }}
              placeholder="ex.: Família do Ícaro"
              maxLength={MAX_LABEL}
              autoComplete="off"
              aria-invalid={Boolean(formError)}
            />
          </Field>
          <Button type="submit" variant="brand" loading={create.isPending} className="sm:mt-[22px]">
            <Link2 /> Gerar link
          </Button>
        </form>

        {created && (
          <div className="grid gap-3 rounded-xl border border-brand/30 bg-accent/40 p-4" role="status">
            <p className="text-sm font-medium">
              Link gerado{created.label ? ` para “${created.label}”` : ""} · vale até {formatDateTimeBR(created.expiresAt, tz)}
            </p>
            <div className="grid gap-2 sm:flex">
              <Input ref={linkRef} readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Link do convite" className="font-mono text-xs sm:flex-1" />
              <div className={cn("grid gap-2", canShare ? "grid-cols-2" : "grid-cols-1")}>
                <Button type="button" variant="outline" onClick={copy}>
                  {copied ? <Check className="text-positive" /> : <Copy />} {copied ? "Copiado" : "Copiar"}
                </Button>
                {canShare && (
                  <Button type="button" variant="outline" onClick={share}>
                    <Share2 /> Compartilhar
                  </Button>
                )}
              </div>
            </div>
            <p className="flex gap-2 text-xs font-medium text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />O link só aparece agora. Se perder, gere outro e revogue este.
            </p>
            {created.warning && (
              <p className="flex gap-2 text-xs font-medium text-destructive">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                {created.warning}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Já enviei — ocultar o link
              </Button>
            </div>
          </div>
        )}

        <section className="grid gap-2" aria-labelledby="hh-invites-title">
          <div className="flex items-baseline justify-between gap-2">
            <h4 id="hh-invites-title" className="text-sm font-semibold">
              Convites gerados
            </h4>
            {items.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {activeCount} {activeCount === 1 ? "ativo" : "ativos"}
              </span>
            )}
          </div>
          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">Nenhum convite gerado ainda.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {items.map((inv) => (
                <li key={inv.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className={cn("min-w-0 break-words", !inv.label && "text-muted-foreground")}>{inv.label ?? "Sem identificação"}</span>
                      <Badge variant={STATUS[inv.status].variant}>{STATUS[inv.status].label}</Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <InviteDates invite={inv} tz={tz} />
                    </p>
                  </div>
                  {inv.status === "ACTIVE" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="self-start text-destructive hover:text-destructive sm:self-center"
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(inv);
                      }}
                    >
                      Revogar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>

      <AlertDialog open={Boolean(revoking)} onOpenChange={(o) => !o && !revoke.isPending && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revogar este convite?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking?.label ? `O link de “${revoking.label}” deixa de funcionar na hora.` : "O link deixa de funcionar na hora."} Se ninguém se cadastrou ainda, será preciso gerar um novo link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {revokeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancelar</AlertDialogCancel>
            <Button variant="destructive" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking.id)}>
              Revogar convite
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

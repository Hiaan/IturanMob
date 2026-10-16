"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check, Copy, Link2, MessageCircle, Pencil, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { MemberAvatar } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateBR, formatDateTimeBR } from "@/lib/dates";
import { MEMBER_ROLE_LABELS, labelOf } from "@/lib/labels";
import { normalizePhoneInput } from "@/lib/phone";
import { useMembers } from "@/features/finance/hooks";
import { useCan, useMe } from "@/features/me/use-me";
import type { MemberDTO } from "@/features/finance/types";

const COLORS = ["#0f766e", "#1d4ed8", "#be185d", "#7c3aed", "#c2410c", "#0369a1", "#4d7c0f"];

const memberSchema = z.object({
  displayName: z.string().trim().min(1, "Informe o nome").max(60),
  relation: z.string().trim().max(40),
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
  color: z.string(),
  canViewOthersPrivate: z.boolean(),
  whatsappPhone: z
    .string()
    .trim()
    .refine((v) => v === "" || normalizePhoneInput(v) !== null, "Informe DDD + número, ex.: (81) 99999-9999. Fora do Brasil, comece com + e o DDI."),
  whatsappAuthorized: z.boolean(),
  whatsappConsent: z.boolean(),
});

function MemberDialog({ member, open, onOpenChange }: { member: MemberDTO | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const canManage = useCan("members:manage");
  const isOwner = me.data?.member.role === "OWNER";
  const isSelf = member?.isMe ?? false;
  const form = useForm<z.infer<typeof memberSchema>>({
    resolver: zodResolver(memberSchema),
    values: member
      ? {
          displayName: member.displayName,
          relation: member.relation ?? "",
          role: member.role as "MEMBER",
          color: member.color,
          canViewOthersPrivate: member.canViewOthersPrivate,
          whatsappPhone: member.whatsappPhone ?? "",
          whatsappAuthorized: member.whatsappAuthorized,
          whatsappConsent: Boolean(member.whatsappConsentAt),
        }
      : undefined,
  });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof memberSchema>) => {
      const body: Record<string, unknown> = {
        displayName: v.displayName,
        relation: v.relation || null,
        color: v.color,
        whatsappPhone: v.whatsappPhone ? normalizePhoneInput(v.whatsappPhone) : null,
      };
      if (canManage) {
        if (v.role !== member!.role) body.role = v.role;
        body.canViewOthersPrivate = v.canViewOthersPrivate;
        body.whatsappAuthorized = v.whatsappAuthorized;
      }
      // Consentimento: somente o próprio participante (ou dependente sem login, pelo administrador).
      if ((isSelf || (!member!.hasLogin && canManage)) && v.whatsappConsent !== Boolean(member!.whatsappConsentAt)) body.whatsappConsent = v.whatsappConsent;
      return api.patch(`/api/v1/members/${member!.id}`, body);
    },
    onSuccess: () => {
      toast.success("Membro atualizado");
      qc.invalidateQueries({ queryKey: qk.members });
      qc.invalidateQueries({ queryKey: qk.me });
      qc.invalidateQueries({ queryKey: ["whatsapp"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!member) return null;
  const e = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Editar {member.displayName}</DialogTitle>
          <DialogDescription>{member.hasLogin ? member.email : "Membro sem acesso ao painel (dependente)."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nome" htmlFor="m-name" error={e.displayName?.message}>
              <Input id="m-name" {...form.register("displayName")} disabled={!canManage && !isSelf} />
            </Field>
            <Field label="Parentesco" htmlFor="m-rel" hint="Ex.: Esposa, Filho">
              <Input id="m-rel" {...form.register("relation")} disabled={!canManage && !isSelf} />
            </Field>
          </div>
          <Field label="Cor">
            <Controller
              control={form.control}
              name="color"
              render={({ field }) => (
                <div className="flex gap-2" role="radiogroup" aria-label="Cor do membro">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={field.value === c}
                      aria-label={c}
                      onClick={() => field.onChange(c)}
                      className="flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition focus-visible:ring-2"
                      style={{ backgroundColor: c, boxShadow: field.value === c ? `0 0 0 2px var(--card), 0 0 0 4px ${c}` : undefined }}
                    >
                      {field.value === c && <Check className="size-4 text-white" />}
                    </button>
                  ))}
                </div>
              )}
            />
          </Field>
          {canManage && member.hasLogin && (
            <div className="grid gap-4 rounded-xl border bg-muted/30 p-4">
              <Field label="Papel" htmlFor="m-role">
                <Controller
                  control={form.control}
                  name="role"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={isSelf || (member.role === "OWNER" && !isOwner)}>
                      <SelectTrigger id="m-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const)
                          .filter((r) => r !== "OWNER" || isOwner)
                          .map((r) => (
                            <SelectItem key={r} value={r}>
                              {MEMBER_ROLE_LABELS[r]}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <label className="flex items-start justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">Pode ver contas e cartões privados dos outros</span>
                  <span className="block text-xs text-muted-foreground">Por padrão, contas privadas são visíveis apenas ao titular.</span>
                </span>
                <Controller control={form.control} name="canViewOthersPrivate" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
              </label>
            </div>
          )}
          <div className="grid gap-4 rounded-xl border p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <MessageCircle className="size-4 text-brand" /> WhatsApp
            </p>
            <Field label="Número do WhatsApp" htmlFor="m-phone" error={e.whatsappPhone?.message} hint="Com DDD. Números do Brasil não precisam do +55; de outros países, comece com + e o DDI.">
              <Input id="m-phone" placeholder="(81) 99999-9999" inputMode="tel" autoComplete="tel" {...form.register("whatsappPhone")} disabled={!canManage && !isSelf} />
            </Field>
            {canManage && (
              <label className="flex items-start justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">Remetente autorizado</span>
                  <span className="block text-xs text-muted-foreground">Somente mensagens de remetentes autorizados, no grupo autorizado, são processadas.</span>
                </span>
                <Controller control={form.control} name="whatsappAuthorized" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
              </label>
            )}
            <label className="flex items-start justify-between gap-3 text-sm">
              <span>
                <span className="font-medium">Consentimento para processamento das mensagens</span>
                <span className="block text-xs text-muted-foreground">
                  {isSelf || !member.hasLogin
                    ? "Autorizo que minhas mensagens no grupo da família sejam lidas e interpretadas para registrar lançamentos financeiros."
                    : "O consentimento só pode ser dado pelo próprio participante."}
                  {member.whatsappConsentAt && ` Concedido em ${formatDateBR(member.whatsappConsentAt.slice(0, 10))}.`}
                </span>
              </span>
              <Controller
                control={form.control}
                name="whatsappConsent"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!(isSelf || (!member.hasLogin && canManage))} />}
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={save.isPending}>
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

function InviteDialog({ open, onOpenChange, dependents }: { open: boolean; onOpenChange: (o: boolean) => void; dependents: MemberDTO[] }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [memberId, setMemberId] = useState("__none__");
  const [url, setUrl] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/v1/invitations", { email, role, memberId: memberId === "__none__" ? null : memberId }),
    onSuccess: (res) => {
      setUrl(res.url);
      qc.invalidateQueries({ queryKey: qk.invitations });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = (o: boolean) => {
    if (!o) {
      setUrl(null);
      setEmail("");
    }
    onOpenChange(o);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar para a família</DialogTitle>
          <DialogDescription>Gere um link de convite (válido por 7 dias) e envie para a pessoa.</DialogDescription>
        </DialogHeader>
        {url ? (
          <div className="grid gap-3">
            <p className="text-sm">Convite criado para <strong>{email}</strong>. Copie e envie o link:</p>
            <div className="flex gap-2">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link do convite" />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copiar link"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  toast.success("Link copiado");
                }}
              >
                <Copy />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Por segurança, o link é exibido apenas agora.</p>
            <DialogFooter>
              <Button variant="brand" onClick={() => close(false)}>
                Concluir
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="E-mail" htmlFor="inv-email">
              <Input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Papel" htmlFor="inv-role">
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["ADMIN", "MEMBER", "VIEWER"] as const).map((r) => (
                    <SelectItem key={r} value={r}>
                      {MEMBER_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {dependents.length > 0 && (
              <Field label="Vincular a um membro existente" htmlFor="inv-member" hint="Opcional: dá acesso a um membro já cadastrado (mantém o histórico).">
                <Select value={memberId} onValueChange={setMemberId}>
                  <SelectTrigger id="inv-member">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Criar novo membro</SelectItem>
                    {dependents.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancelar
              </Button>
              <Button type="submit" variant="brand" loading={create.isPending} disabled={!email.trim()}>
                <Link2 /> Gerar convite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MembersSection() {
  const qc = useQueryClient();
  const members = useMembers();
  const canManage = useCan("members:manage");
  const [editing, setEditing] = useState<MemberDTO | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [dependentName, setDependentName] = useState("");
  const [dependentRelation, setDependentRelation] = useState("");
  const invitations = useQuery({ queryKey: qk.invitations, queryFn: () => api.get<Invitation[]>("/api/v1/invitations"), enabled: canManage });
  const addDependent = useMutation({
    mutationFn: () => api.post("/api/v1/members", { displayName: dependentName, relation: dependentRelation || null }),
    onSuccess: () => {
      toast.success("Membro adicionado");
      setDependentName("");
      setDependentRelation("");
      qc.invalidateQueries({ queryKey: qk.members });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/invitations/${id}`),
    onSuccess: () => {
      toast.success("Convite revogado");
      qc.invalidateQueries({ queryKey: qk.invitations });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (members.isLoading) return <Skeleton className="h-80 rounded-xl" />;
  const list = members.data ?? [];

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start">
          <div>
            <CardTitle>Membros da família</CardTitle>
            <CardDescription>Quem participa das finanças, papéis, permissões e autorização no WhatsApp.</CardDescription>
          </div>
          {canManage && (
            <CardAction>
              <Button variant="brand" size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlus /> Convidar
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {list.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                <MemberAvatar name={m.displayName} color={m.color} className="size-10" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {m.displayName}
                    {m.isMe && <Badge variant="brand">você</Badge>}
                    {!m.isActive && <Badge variant="muted">inativo</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[m.relation, labelOf(MEMBER_ROLE_LABELS, m.role), m.hasLogin ? m.email : "sem acesso ao painel", m.lastLoginAt ? `último acesso ${formatDateTimeBR(m.lastLoginAt)}` : null].filter(Boolean).join(" · ")}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.whatsappPhone ? <Badge variant="outline">{m.whatsappPhone}</Badge> : null}
                    {m.whatsappAuthorized ? (
                      <Badge variant="positive">
                        <ShieldCheck /> WhatsApp autorizado
                      </Badge>
                    ) : (
                      <Badge variant="muted">WhatsApp não autorizado</Badge>
                    )}
                    {m.whatsappConsentAt ? (
                      <Badge variant="positive">
                        <Check /> Consentimento dado
                      </Badge>
                    ) : (
                      <Badge variant="warning">
                        <X /> Sem consentimento
                      </Badge>
                    )}
                    {m.canViewOthersPrivate && <Badge variant="info">vê contas privadas</Badge>}
                  </div>
                </div>
                {(canManage || m.isMe) && (
                  <Button variant="outline" size="sm" onClick={() => setEditing(m)}>
                    <Pencil /> Editar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {canManage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-4" /> Adicionar dependente
              </CardTitle>
              <CardDescription>Membros sem acesso ao painel (ex.: filhos), para atribuir despesas e acompanhar gastos.</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  addDependent.mutate();
                }}
              >
                <Field label="Nome" htmlFor="dep-name">
                  <Input id="dep-name" value={dependentName} onChange={(e) => setDependentName(e.target.value)} />
                </Field>
                <Field label="Parentesco" htmlFor="dep-rel">
                  <Input id="dep-rel" placeholder="Filho" value={dependentRelation} onChange={(e) => setDependentRelation(e.target.value)} />
                </Field>
                <Button type="submit" variant="outline" loading={addDependent.isPending} disabled={!dependentName.trim()}>
                  Adicionar
                </Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Convites pendentes</CardTitle>
              <CardDescription>Links ainda não utilizados.</CardDescription>
            </CardHeader>
            <CardContent>
              {!invitations.data?.length ? (
                <p className="text-sm text-muted-foreground">Nenhum convite pendente.</p>
              ) : (
                <ul className="divide-y">
                  {invitations.data.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {labelOf(MEMBER_ROLE_LABELS, inv.role)} · expira em {formatDateTimeBR(inv.expiresAt)}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => revoke.mutate(inv.id)}>
                        Revogar
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <MemberDialog member={editing} open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} dependents={list.filter((m) => !m.hasLogin)} />
    </div>
  );
}

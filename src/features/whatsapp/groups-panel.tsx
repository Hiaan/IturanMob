"use client";

import { useState } from "react";
import { Briefcase, CircleHelp, FlaskConical, Info, Loader2, MessageCircleQuestion, RefreshCw, ShieldCheck, User, Users, type LucideIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/shared/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCan } from "@/features/me/use-me";
import { useHousehold, useUpdateSettings, type HouseholdSettingsDTO } from "@/features/settings/use-household";
import { GROUP_NATURE_LABELS, useSyncGroups, useUpdateGroup } from "./hooks";
import type { WaGroup, WaGroupNature, WaStatus } from "./types";

type NatureChoice = WaGroupNature | "NONE";
const NATURE_CHOICES: NatureChoice[] = ["PERSONAL", "BUSINESS", "NONE"];
const NATURE_ICONS: Record<NatureChoice, LucideIcon> = { PERSONAL: User, BUSINESS: Briefcase, NONE: CircleHelp };

export const GROUP_NATURE_EXPLANATION =
  "A natureza do grupo vale para os lançamentos que chegam por ele. A mensagem sempre vence: “empresa”, “PJ”, “PF”, “pessoa física”. Regras de natureza continuam valendo. Trocar a natureza do grupo não muda lançamentos já feitos.";

/** Pessoa física | Empresa | Não atribuído para um grupo autorizado. */
function GroupNatureSelector({ group, disabled, pending, onChange }: { group: WaGroup; disabled: boolean; pending: NatureChoice | null; onChange: (n: WaGroupNature | null) => void }) {
  const value: NatureChoice = group.defaultNature ?? "NONE";
  return (
    <div role="radiogroup" aria-label={`Natureza do grupo ${group.name}`} className="grid grid-cols-[auto_auto_auto] gap-1 rounded-xl bg-muted p-1">
      {NATURE_CHOICES.map((n) => {
        const Icon = NATURE_ICONS[n];
        const checked = value === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !checked && onChange(n === "NONE" ? null : n)}
            className={cn(
              "flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-xs font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
              checked ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {pending === n ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            ) : (
              <Icon className={cn("hidden size-3.5 shrink-0 min-[400px]:block", checked && n === "BUSINESS" && "text-series-7", checked && n === "PERSONAL" && "text-brand", checked && n === "NONE" && "text-warning")} aria-hidden />
            )}
            <span className="truncate">{GROUP_NATURE_LABELS[n]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** O que acontece com mensagens sem indicação em grupo "Não atribuído". */
function UnassignedSetting({ canEdit }: { canEdit: boolean }) {
  const household = useHousehold();
  const update = useUpdateSettings();
  const settings = household.data?.settings;
  if (!settings) return null;
  const current: HouseholdSettingsDTO["whatsappUnassignedNature"] = update.isPending && update.variables?.whatsappUnassignedNature ? update.variables.whatsappUnassignedNature : (settings.whatsappUnassignedNature ?? "ASK");
  const familyLabel = settings.defaultReportScope === "BUSINESS" ? "Empresa" : "Pessoa física";
  const options: Array<{ value: HouseholdSettingsDTO["whatsappUnassignedNature"]; title: string; hint: string; icon: LucideIcon }> = [
    { value: "ASK", title: "Perguntar no grupo", hint: "“É pessoa física ou empresa? (1 PF / 2 Empresa)”", icon: MessageCircleQuestion },
    {
      value: "FAMILY_DEFAULT",
      title: `Usar o padrão da família (${familyLabel})`,
      hint:
        settings.defaultReportScope === "BUSINESS"
          ? "O lançamento entra como Empresa, sem perguntar."
          : settings.defaultReportScope === "ALL"
            ? "O recorte padrão da família é Tudo: o lançamento entra como pessoa física, sem perguntar."
            : "O lançamento entra como pessoa física, sem perguntar.",
      icon: settings.defaultReportScope === "BUSINESS" ? Briefcase : User,
    },
  ];
  return (
    <section aria-labelledby="wa-unassigned-title" className="space-y-2">
      <div>
        <h3 id="wa-unassigned-title" className="text-sm font-semibold">
          Grupo “Não atribuído”
        </h3>
        <p className="text-xs text-muted-foreground">Quando o grupo não tem natureza e a mensagem não diz se é pessoa física ou empresa:</p>
      </div>
      <div className="grid gap-2" role="radiogroup" aria-labelledby="wa-unassigned-title">
        {options.map((o) => {
          const checked = current === o.value;
          const Icon = o.icon;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={!canEdit || update.isPending}
              onClick={() => !checked && update.mutate({ whatsappUnassignedNature: o.value })}
              className={cn(
                "flex w-full gap-3 rounded-xl border p-3 text-left outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed",
                checked ? "border-brand/50 bg-accent/50" : "hover:bg-muted/50",
                !canEdit && "opacity-80",
              )}
            >
              <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-brand" : "border-muted-foreground/50")} aria-hidden>
                {checked && <span className="size-2 rounded-full bg-brand" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> {o.title}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {!canEdit && <p className="text-xs text-muted-foreground">Só quem administra a família pode mudar esta opção.</p>}
    </section>
  );
}

export function GroupsPanel({ status, canManage, timezone }: { status: WaStatus; canManage: boolean; timezone?: string }) {
  const sync = useSyncGroups();
  const update = useUpdateGroup();
  const canSettings = useCan("settings:manage");
  const hhSettings = useHousehold().data?.settings;
  const unassignedText = !hhSettings
    ? "Não atribuído: veja abaixo o que acontece quando a mensagem não diz se é pessoa física ou empresa."
    : hhSettings.whatsappUnassignedNature === "FAMILY_DEFAULT"
      ? `Não atribuído: se a mensagem não disser, entra como ${hhSettings.defaultReportScope === "BUSINESS" ? "Empresa" : "Pessoa física"} (padrão da família).`
      : "Não atribuído: se a mensagem não disser, o bot pergunta no grupo “1 PF / 2 Empresa”.";
  const [confirm, setConfirm] = useState<{ group: WaGroup; authorized: boolean } | null>(null);
  const groups = [...status.groups].sort((a, b) => Number(b.isAuthorized) - Number(a.isAuthorized) || a.name.localeCompare(b.name, "pt-BR"));
  const authorized = groups.filter((g) => g.isAuthorized);
  const pendingFor = (g: WaGroup): NatureChoice | null =>
    update.isPending && update.variables?.id === g.id && update.variables.defaultNature !== undefined ? (update.variables.defaultNature ?? "NONE") : null;

  if (!status.capabilities.groups) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat autorizado</CardTitle>
          <CardDescription>Na API oficial não há grupos: cada membro autorizado conversa diretamente com o número comercial.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            Somente as conversas de membros autorizados e com consentimento são processadas. Mensagens de qualquer outra pessoa são descartadas sem serem armazenadas.
          </p>
        </CardContent>
      </Card>
    );
  }

  const others = confirm ? authorized.filter((g) => g.id !== confirm.group.id).length : 0;

  return (
    <Card>
      <CardHeader className="sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle>Grupos autorizados</CardTitle>
          <CardDescription className="mt-1">
            Somente os grupos autorizados são processados — dá para autorizar mais de um (ex.: o da família e o da empresa). Mensagens de outras conversas não são lidas nem armazenadas.
          </CardDescription>
        </div>
        {canManage && (
          <CardAction className="mt-2 sm:mt-0">
            <Button variant="outline" size="sm" onClick={() => sync.mutate()} loading={sync.isPending}>
              <RefreshCw /> Sincronizar grupos
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nenhum grupo sincronizado"
            description={
              status.provider === "SIMULATOR"
                ? "Clique em “Sincronizar grupos” para criar os grupos simulados (família e empresa) e depois autorize-os."
                : status.status === "CONNECTED"
                  ? "Clique em “Sincronizar grupos” para listar os grupos do número conectado."
                  : "Conecte o WhatsApp: os grupos são sincronizados automaticamente após a conexão."
            }
            className="py-8"
          />
        ) : (
          <ul className="divide-y rounded-xl border">
            {groups.map((g) => {
              const nature = g.defaultNature;
              return (
                <li key={g.id} className={cn("space-y-3 p-3.5", g.isAuthorized && "bg-accent/40")}>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-full",
                        g.isAuthorized ? (nature === "BUSINESS" ? "bg-series-7/12 text-series-7" : "bg-positive/12 text-positive") : "bg-muted text-muted-foreground",
                      )}
                    >
                      {g.isSimulator ? <FlaskConical className="size-4" aria-hidden /> : nature === "BUSINESS" && g.isAuthorized ? <Briefcase className="size-4" aria-hidden /> : <Users className="size-4" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                        <span className="min-w-0 break-words">{g.name}</span>
                        {g.isAuthorized && (
                          <Badge variant="positive">
                            <ShieldCheck aria-hidden /> Autorizado
                          </Badge>
                        )}
                        {g.isSimulator && <Badge variant="info">Simulado</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {g.participantsCount} participante{g.participantsCount === 1 ? "" : "s"} · sincronizado em {formatDateTimeBR(g.lastSyncedAt, timezone)}
                      </p>
                    </div>
                    {canManage ? (
                      <Switch
                        checked={g.isAuthorized}
                        disabled={update.isPending}
                        onCheckedChange={(v) => setConfirm({ group: g, authorized: v })}
                        aria-label={g.isAuthorized ? `Revogar autorização do grupo ${g.name}` : `Autorizar o grupo ${g.name}`}
                      />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">{g.isAuthorized ? "Processado" : "Ignorado"}</span>
                    )}
                  </div>
                  {g.isAuthorized && (
                    <div className="space-y-1.5 sm:pl-12">
                      <p className="text-xs font-medium text-muted-foreground">Natureza dos lançamentos deste grupo</p>
                      {canManage ? (
                        <GroupNatureSelector group={g} disabled={update.isPending} pending={pendingFor(g)} onChange={(n) => update.mutate({ id: g.id, defaultNature: n })} />
                      ) : (
                        <p className="text-sm font-medium">{GROUP_NATURE_LABELS[nature ?? "NONE"]}</p>
                      )}
                      {!nature && <p className="text-xs text-warning">{unassignedText}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {authorized.length === 0 && groups.length > 0 && (
          <p className="flex items-start gap-2 text-sm text-warning">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> Nenhum grupo autorizado: nenhuma mensagem está sendo processada.
          </p>
        )}
        {groups.length > 0 && (
          <>
            <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{GROUP_NATURE_EXPLANATION}</span>
            </p>
            <UnassignedSetting canEdit={canManage && canSettings} />
          </>
        )}
      </CardContent>

      <AlertDialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.authorized ? `Autorizar “${confirm.group.name}”?` : `Revogar “${confirm?.group.name}”?`}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {confirm?.authorized ? (
                  <>
                    <p>As mensagens dos participantes autorizados (com consentimento) neste grupo viram lançamentos e consultas, e o bot responde aqui.</p>
                    {others > 0 && <p>Os outros grupos autorizados continuam sendo processados.</p>}
                    <p className="font-medium text-foreground">
                      {confirm.group.defaultNature
                        ? `Natureza do grupo: ${GROUP_NATURE_LABELS[confirm.group.defaultNature]} (a mesma de antes).`
                        : others === 0
                          ? "Por ser o primeiro grupo autorizado, ele começa como Pessoa física."
                          : "Ele começa como “Não atribuído”: depois de autorizar, escolha Pessoa física ou Empresa."}
                    </p>
                    <p>Mensagens de outras conversas não são lidas nem armazenadas.</p>
                  </>
                ) : (
                  <p>As mensagens deste grupo deixarão de ser processadas e o bot não responderá mais nele. O histórico já registrado é mantido.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.authorized ? undefined : buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (confirm) update.mutate({ id: confirm.group.id, authorized: confirm.authorized });
                setConfirm(null);
              }}
            >
              {confirm?.authorized ? "Autorizar grupo" : "Revogar autorização"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

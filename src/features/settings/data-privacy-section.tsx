"use client";

import { useState } from "react";
import { Download, FileLock2, Info, ShieldCheck, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api, downloadFile, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";

function ConfirmTypingDialog({
  open,
  onOpenChange,
  title,
  description,
  expected,
  inputLabel,
  actionLabel,
  pending,
  onConfirm,
  caseSensitive,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: React.ReactNode;
  expected: string;
  inputLabel: React.ReactNode;
  actionLabel: string;
  pending: boolean;
  onConfirm: (typed: string) => void;
  caseSensitive?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const matches = caseSensitive ? typed.trim() === expected.trim() : typed.trim().toUpperCase() === expected.toUpperCase();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setTyped("");
        onOpenChange(v);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !pending) onConfirm(typed.trim());
          }}
          className="grid gap-4"
        >
          <Field label={inputLabel} htmlFor="confirm-typing">
            <Input id="confirm-typing" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={typed !== "" && !matches ? true : undefined} />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancelar</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!matches} loading={pending}>
              {actionLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Seção de Configurações: portabilidade (LGPD), explicação de tratamento de dados e exclusões. */
export function DataPrivacySection() {
  const me = useMe();
  const canExport = useCan("data:export");
  const canDeleteHousehold = useCan("household:delete");
  const [exporting, setExporting] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [householdOpen, setHouseholdOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isOwner = me.data?.member.role === "OWNER";
  const householdName = me.data?.household.name ?? "";

  const exportAll = async () => {
    setExporting(true);
    try {
      await downloadFile("/api/v1/exports/full", undefined, "finance-ai-dados.json");
      toast.success("Exportação gerada", { description: "O arquivo JSON com todos os dados da família foi baixado." });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async (confirmation: string) => {
    setDeleting(true);
    try {
      await api.post("/api/v1/privacy/delete-my-account", { confirmation });
      toast.success("Conta excluída");
      window.location.href = "/login";
    } catch (e) {
      toast.error(errorMessage(e));
      setDeleting(false);
    }
  };

  const deleteHousehold = async (confirmation: string) => {
    setDeleting(true);
    try {
      await api.post("/api/v1/privacy/delete-household", { confirmation });
      toast.success("Família excluída");
      window.location.href = "/cadastro";
    } catch (e) {
      toast.error(errorMessage(e));
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-brand" aria-hidden /> Seus dados e a LGPD
          </CardTitle>
          <CardDescription>Como o Finance AI trata os dados da sua família.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="grid gap-3 text-sm md:grid-cols-3">
            <li className="rounded-lg border p-3">
              <p className="font-medium">Portabilidade</p>
              <p className="mt-1 text-muted-foreground">Você pode baixar a qualquer momento todos os dados da família em JSON: contas, cartões, faturas, transações (inclusive as excluídas), orçamentos, metas, recorrências, notificações e auditoria.</p>
            </li>
            <li className="rounded-lg border p-3">
              <p className="font-medium">Minimização</p>
              <p className="mt-1 text-muted-foreground">Senhas, sessões, tokens de convite, credenciais do WhatsApp, chaves de API e o conteúdo de mídias nunca saem nas exportações. Cartões guardam só os 4 últimos dígitos.</p>
            </li>
            <li className="rounded-lg border p-3">
              <p className="font-medium">Retenção</p>
              <p className="mt-1 text-muted-foreground">Áudios e comprovantes são mantidos pelo prazo configurado e depois apagados; arquivos ficam criptografados em repouso. Cópias de segurança seguem a política de retenção de backups.</p>
            </li>
          </ul>
          <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <FileLock2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <p className="text-sm font-medium">Exportação completa (JSON)</p>
                <p className="text-xs text-muted-foreground">
                  {me.data?.canViewOthersPrivate || isOwner
                    ? "Inclui todos os dados da família visíveis para você."
                    : "Contas e cartões privados de outros membros não são incluídos."}{" "}
                  Valores em centavos e datas no formato AAAA-MM-DD.
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={exportAll} loading={exporting} disabled={!canExport} className="shrink-0">
              <Download /> Baixar meus dados
            </Button>
          </div>
          {!canExport && !me.isLoading && <p className="text-xs text-muted-foreground">Seu perfil não tem permissão para exportar dados. Peça a um administrador.</p>}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="size-4" aria-hidden /> Zona de perigo
          </CardTitle>
          <CardDescription>Ações permanentes. Baixe seus dados antes de continuar.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {me.isLoading ? (
            <Skeleton className="h-20 rounded-lg" />
          ) : (
            <>
              <div className={cn("flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between", isOwner && "opacity-80")}>
                <div>
                  <p className="text-sm font-medium">Excluir minha conta</p>
                  <p className="text-xs text-muted-foreground">
                    {isOwner
                      ? "Como proprietário, transfira a propriedade para outro membro antes de excluir sua conta — ou exclua a família inteira."
                      : "Seu login e seus dados pessoais são removidos. Os lançamentos da família são mantidos, associados a “Ex-membro”."}
                  </p>
                </div>
                <Button variant="outline" className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={isOwner} onClick={() => setAccountOpen(true)}>
                  <UserX /> Excluir minha conta
                </Button>
              </div>
              {canDeleteHousehold && (
                <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">Excluir a família e todos os dados</p>
                    <p className="text-xs text-muted-foreground">Apaga contas, cartões, transações, anexos, importações e o acesso de todos os membros. Não pode ser desfeito.</p>
                  </div>
                  <Button variant="destructive" className="shrink-0" onClick={() => setHouseholdOpen(true)}>
                    <Trash2 /> Excluir família
                  </Button>
                </div>
              )}
            </>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Toda exclusão é registrada (sem dados pessoais) para fins de segurança.
          </p>
        </CardContent>
      </Card>

      <ConfirmTypingDialog
        open={accountOpen}
        onOpenChange={setAccountOpen}
        title="Excluir sua conta?"
        description={
          <>
            <p>Você perderá o acesso a esta família. Seu nome será substituído por “Ex-membro” nos lançamentos, que continuam no histórico da família.</p>
            <p>Notificações, preferências e conversas com o assistente serão apagadas. Esta ação não pode ser desfeita.</p>
          </>
        }
        expected="EXCLUIR"
        inputLabel={
          <>
            Digite <strong>EXCLUIR</strong> para confirmar
          </>
        }
        actionLabel="Excluir minha conta"
        pending={deleting}
        onConfirm={deleteAccount}
      />

      <ConfirmTypingDialog
        open={householdOpen}
        onOpenChange={setHouseholdOpen}
        title="Excluir a família definitivamente?"
        description={
          <>
            <p>
              Todos os dados de <strong className="text-foreground">{householdName}</strong> serão apagados: contas, cartões, faturas, transações, orçamentos, metas, anexos e arquivos
              importados. Todos os membros perdem o acesso.
            </p>
            <p>Esta ação não pode ser desfeita.</p>
          </>
        }
        expected={householdName}
        caseSensitive
        inputLabel={
          <>
            Digite o nome exato da família: <strong>{householdName}</strong>
          </>
        }
        actionLabel="Excluir família"
        pending={deleting}
        onConfirm={deleteHousehold}
      />
    </div>
  );
}


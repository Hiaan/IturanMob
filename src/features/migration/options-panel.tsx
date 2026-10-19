"use client";

import { useState } from "react";
import { BookmarkPlus, CreditCard, Landmark, Settings2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { MigrationDTO } from "@/server/modules/migration/types";
import { baseFileName } from "./labels";
import { useMigrationBusy, useUpdateOptions } from "./use-migration";

const NONE = "__none__";
/** Limite do servidor para o nome do formato. */
const TEMPLATE_NAME_MAX = 60;
const defaultName = (m: MigrationDTO) => baseFileName(m.fileName).slice(0, TEMPLATE_NAME_MAX);

function TemplateName({ migration: m, disabled, onSave }: { migration: MigrationDTO; disabled: boolean; onSave: (name: string) => void }) {
  const saved = m.options.templateName ?? "";
  const [value, setValue] = useState(saved || defaultName(m));
  const commit = () => {
    const clean = value.trim();
    if (!clean) {
      setValue(saved || defaultName(m));
      return;
    }
    if (clean !== saved) onSave(clean);
  };
  return (
    <Field label="Nome do formato" htmlFor="mig-template-name" hint="Aparece em “Formatos salvos” e no aviso “Formato reconhecido”.">
      <Input
        id="mig-template-name"
        value={value}
        maxLength={TEMPLATE_NAME_MAX}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        readOnly={disabled}
      />
    </Field>
  );
}

/** Opções da migração: destinos padrão e "Salvar este formato". */
export function OptionsPanel({ migration: m }: { migration: MigrationDTO }) {
  const update = useUpdateOptions(m.id);
  const busy = useMigrationBusy(m.id);
  const o = m.options;
  const accounts = m.targets.accounts;
  const cards = m.targets.cards;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="size-4 text-muted-foreground" aria-hidden /> Opções da migração
        </CardTitle>
        <CardDescription className="text-xs">Valem para as linhas sem conta ou cartão na planilha (e para as contas e cartões marcados como “Ignorar”).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <Field label="Conta padrão" htmlFor="mig-default-account" hint="Recebe as linhas sem conta/banco. Sem conta, os lançamentos entram sem alterar saldos.">
          <Select value={o.defaultAccountId ?? NONE} onValueChange={(v) => update.mutate({ defaultAccountId: v === NONE ? null : v })} disabled={busy}>
            <SelectTrigger id="mig-default-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nenhuma — não altera saldos</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="flex items-center gap-2">
                    <Landmark className="size-3.5 text-muted-foreground" aria-hidden /> {a.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Cartão padrão"
          htmlFor="mig-default-card"
          hint={cards.length ? "Recebe as compras no crédito sem cartão identificado na planilha." : "Nenhum cartão no app ainda."}
        >
          <Select value={o.defaultCardId ?? NONE} onValueChange={(v) => update.mutate({ defaultCardId: v === NONE ? null : v })} disabled={busy || !cards.length}>
            <SelectTrigger id="mig-default-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nenhum</SelectItem>
              {cards.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-2">
                    <CreditCard className="size-3.5 text-muted-foreground" aria-hidden /> {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="grid gap-3 rounded-lg border p-3 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <Label htmlFor="mig-save-template" className="flex items-center gap-1.5 text-sm">
                <BookmarkPlus className="size-4 text-muted-foreground" aria-hidden /> Salvar este formato para a próxima planilha
              </Label>
              <p className="text-xs text-muted-foreground">
                Na próxima vez que você enviar uma planilha com as mesmas abas e colunas, o app já preenche tudo e só pergunta o que for novo. É salvo ao importar.
              </p>
            </div>
            <Switch
              id="mig-save-template"
              checked={o.saveTemplate}
              onCheckedChange={(v) => update.mutate(v && !o.templateName ? { saveTemplate: true, templateName: defaultName(m) } : { saveTemplate: v })}
              disabled={busy}
            />
          </div>
          {o.saveTemplate && <TemplateName key={o.templateName ?? ""} migration={m} disabled={busy} onSave={(templateName) => update.mutate({ templateName })} />}
        </div>
      </CardContent>
    </Card>
  );
}

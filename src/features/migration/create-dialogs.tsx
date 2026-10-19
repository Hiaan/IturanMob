"use client";

import { useState } from "react";
import { CreditCard, Landmark, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ACCOUNT_TYPE_LABELS } from "@/lib/labels";
import { normalizeText } from "@/lib/utils";
import type { Correspondence, CorrespondenceDecision, MigrationDTO } from "@/server/modules/migration/types";
import { itemAmounts } from "./labels";
import { useCreateDestination, type DestinationInput } from "./use-migration";

const NONE = "__none__";
/** Limites do servidor: categoria 50; conta, cartão e instituição 60. */
const MAX_CATEGORY_NAME = 50;
const MAX_NAME = 60;

type Kind = "EXPENSE" | "INCOME";
type AccountType = NonNullable<DestinationInput["accountType"]>;

/** Categoria-mãe provável de uma subcategoria: a escolhida para a categoria da mesma linha, ou uma com o mesmo nome. */
function defaultParent(m: MigrationDTO, item: Correspondence): string | null {
  if (item.field !== "subcategory" || !item.parentLabel) return null;
  const parent = normalizeText(item.parentLabel);
  const mapped = m.correspondences.find((c) => c.field === "category" && normalizeText(c.label) === parent)?.decision;
  if (mapped?.action === "MAP" && mapped.targetType === "CATEGORY") return mapped.targetId;
  return m.targets.categories.find((c) => normalizeText(c.name) === parent)?.id ?? null;
}

function CategoryForm({ migration: m, item, onSubmit, onCancel }: { migration: MigrationDTO; item: Correspondence; onSubmit: (d: CorrespondenceDecision) => void; onCancel: () => void }) {
  const initialParent = defaultParent(m, item);
  const parentKind = m.targets.categories.find((c) => c.id === initialParent)?.kind;
  const [name, setName] = useState(item.label.slice(0, MAX_CATEGORY_NAME));
  const [kind, setKind] = useState<Kind>(parentKind ?? (item.kindHint === "INCOME" ? "INCOME" : "EXPENSE"));
  const [parentId, setParentId] = useState<string | null>(initialParent);
  const [error, setError] = useState<string | null>(null);
  const parents = m.targets.categories.filter((c) => c.kind === kind);
  const base = `create-cat-${item.field}`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) {
      setError("Informe o nome.");
      return;
    }
    onSubmit({ action: "CREATE", name: clean, parentId, kind });
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{item.field === "subcategory" ? "Criar subcategoria" : "Criar categoria"}</DialogTitle>
        <DialogDescription>
          Para “{item.label}”{item.parentLabel ? ` (em ${item.parentLabel})` : ""}: {itemAmounts(item)}. A categoria é criada ao importar e removida se você desfizer a migração sem usá-la.
        </DialogDescription>
      </DialogHeader>
      <Field label="Nome" htmlFor={`${base}-name`} error={error ?? undefined} required>
        <Input
          id={`${base}-name`}
          value={name}
          maxLength={MAX_CATEGORY_NAME}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error) || undefined}
          autoFocus
        />
      </Field>
      <div className="grid gap-1.5">
        <span className="text-[13px] font-medium" id={`${base}-kind`}>
          Tipo
        </span>
        <Tabs
          value={kind}
          onValueChange={(v) => {
            const next = v as Kind;
            setKind(next);
            if (parentId && m.targets.categories.find((c) => c.id === parentId)?.kind !== next) setParentId(null);
          }}
        >
          <TabsList aria-labelledby={`${base}-kind`}>
            <TabsTrigger value="EXPENSE">Despesa</TabsTrigger>
            <TabsTrigger value="INCOME">Receita</TabsTrigger>
          </TabsList>
        </Tabs>
        {item.kindHint === "MIXED" && <p className="text-xs text-muted-foreground">As linhas deste item têm entradas e saídas: escolha o tipo que predomina.</p>}
      </div>
      <Field label="Dentro de (opcional)" htmlFor={`${base}-parent`} hint="Escolha uma categoria para criar como subcategoria dela.">
        <Select value={parentId ?? NONE} onValueChange={(v) => setParentId(v === NONE ? null : v)}>
          <SelectTrigger id={`${base}-parent`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Nenhuma — categoria principal</SelectItem>
            {parents.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="brand">
          <Plus aria-hidden /> {parentId ? "Criar subcategoria" : "Criar categoria"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Criar nova" para categorias e subcategorias (decisão CREATE, gravada ao importar). */
export function CreateCategoryDialog({
  migration,
  item,
  onOpenChange,
  onSubmit,
}: {
  migration: MigrationDTO;
  item: Correspondence | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (item: Correspondence, decision: CorrespondenceDecision) => void;
}) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent>
        {item && (
          <CategoryForm
            key={`${item.field}:${item.key}`}
            migration={migration}
            item={item}
            onCancel={() => onOpenChange(false)}
            onSubmit={(d) => {
              onSubmit(item, d);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function parseDay(v: string): number | null {
  if (!/^\d{1,2}$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 1 && n <= 31 ? n : null;
}

function DestinationForm({ migration: m, item, onDone, onCancel }: { migration: MigrationDTO; item: Correspondence; onDone: () => void; onCancel: () => void }) {
  const create = useCreateDestination(m.id);
  const field = item.field === "card" ? "card" : "account";
  const [kind, setKind] = useState<"ACCOUNT" | "CARD">(field === "card" ? "CARD" : "ACCOUNT");
  const [name, setName] = useState(item.label.slice(0, MAX_NAME));
  const [accountType, setAccountType] = useState<AccountType>("CHECKING");
  const [institution, setInstitution] = useState("");
  const [closing, setClosing] = useState("");
  const [due, setDue] = useState("");
  const [errors, setErrors] = useState<{ name?: string; closing?: string; due?: string }>({});
  const base = `create-dest-${item.field}`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    const closingDay = parseDay(closing);
    const dueDay = parseDay(due);
    const next: typeof errors = {};
    if (!clean) next.name = "Informe o nome.";
    if (kind === "CARD" && closingDay === null) next.closing = "Informe o dia de fechamento (1 a 31).";
    if (kind === "CARD" && dueDay === null) next.due = "Informe o dia de vencimento (1 a 31).";
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: DestinationInput =
      kind === "CARD"
        ? { field, key: item.key, kind, name: clean, closingDay: closingDay!, dueDay: dueDay! }
        : { field, key: item.key, kind, name: clean, accountType, institution: institution.trim() || null };
    create.mutate(body, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{kind === "CARD" ? "Criar cartão" : "Criar conta"}</DialogTitle>
        <DialogDescription>
          Para “{item.label}”: {itemAmounts(item)}. {kind === "CARD" ? "O cartão" : "A conta"} é {kind === "CARD" ? "criado" : "criada"} agora, já {kind === "CARD" ? "ligado" : "ligada"} a este item; se
          você desfizer a migração e {kind === "CARD" ? "ele" : "ela"} não tiver outro uso, é {kind === "CARD" ? "removido" : "removida"}.
        </DialogDescription>
      </DialogHeader>
      {field === "account" && (
        <Tabs value={kind} onValueChange={(v) => setKind(v as "ACCOUNT" | "CARD")}>
          <TabsList aria-label="O que criar">
            <TabsTrigger value="ACCOUNT">
              <Landmark aria-hidden /> Conta
            </TabsTrigger>
            <TabsTrigger value="CARD">
              <CreditCard aria-hidden /> Cartão de crédito
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <Field label="Nome" htmlFor={`${base}-name`} error={errors.name} required>
        <Input id={`${base}-name`} value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} autoFocus />
      </Field>
      {kind === "ACCOUNT" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo da conta" htmlFor={`${base}-type`}>
            <Select value={accountType} onValueChange={(v) => setAccountType(v as AccountType)}>
              <SelectTrigger id={`${base}-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {ACCOUNT_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Banco / instituição (opcional)" htmlFor={`${base}-inst`}>
            <Input id={`${base}-inst`} value={institution} maxLength={MAX_NAME} onChange={(e) => setInstitution(e.target.value)} placeholder="Ex.: Nubank" />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">O saldo inicial é perguntado na prévia (a planilha pode sugerir um, pela coluna Saldo ou pela linha “Saldo inicial”).</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Dia de fechamento" htmlFor={`${base}-closing`} error={errors.closing} required>
            <Input
              id={`${base}-closing`}
              inputMode="numeric"
              type="number"
              min={1}
              max={31}
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
              aria-invalid={Boolean(errors.closing) || undefined}
              placeholder="1 a 31"
            />
          </Field>
          <Field label="Dia de vencimento" htmlFor={`${base}-due`} error={errors.due} required>
            <Input
              id={`${base}-due`}
              inputMode="numeric"
              type="number"
              min={1}
              max={31}
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-invalid={Boolean(errors.due) || undefined}
              placeholder="1 a 31"
            />
          </Field>
          <p className="col-span-2 text-xs text-muted-foreground">Os dias definem em qual fatura cada compra da planilha entra. Confira na fatura do cartão.</p>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
          Cancelar
        </Button>
        <Button type="submit" variant="brand" loading={create.isPending}>
          <Plus aria-hidden /> {kind === "CARD" ? "Criar cartão" : "Criar conta"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Criar nova" para contas e cartões: cria na hora (POST /destinations) e liga o item a ela. */
export function CreateDestinationDialog({ migration, item, onOpenChange }: { migration: MigrationDTO; item: Correspondence | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent>
        {item && <DestinationForm key={`${item.field}:${item.key}`} migration={migration} item={item} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

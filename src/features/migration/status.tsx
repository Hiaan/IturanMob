"use client";

import { Ban, CheckCircle2, Eye, LoaderCircle, SlidersHorizontal, Undo2, XCircle, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { MigrationStatus } from "@/server/modules/migration/types";

type Variant = "info" | "positive" | "warning" | "muted" | "negative" | "brand";

export const MIGRATION_STATUS: Record<MigrationStatus, { label: string; icon: LucideIcon; variant: Variant; spin?: boolean }> = {
  READING: { label: "Lendo a planilha", icon: LoaderCircle, variant: "info", spin: true },
  READY: { label: "Em ajuste", icon: SlidersHorizontal, variant: "info" },
  PREVIEWING: { label: "Gerando prévia", icon: LoaderCircle, variant: "info", spin: true },
  PREVIEW: { label: "Prévia pronta", icon: Eye, variant: "brand" },
  COMMITTING: { label: "Importando", icon: LoaderCircle, variant: "info", spin: true },
  IMPORTED: { label: "Importada", icon: CheckCircle2, variant: "positive" },
  UNDONE: { label: "Desfeita", icon: Undo2, variant: "muted" },
  DISCARDED: { label: "Descartada", icon: Ban, variant: "muted" },
  FAILED: { label: "Falhou", icon: XCircle, variant: "negative" },
};

export function MigrationStatusBadge({ status }: { status: MigrationStatus }) {
  const meta = MIGRATION_STATUS[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon className={cn(meta.spin && "animate-spin")} aria-hidden /> {meta.label}
    </Badge>
  );
}

/** Barra de progresso do trabalho em segundo plano (leitura, prévia, gravação). */
export function ProgressPanel({ title, progress, label, hint, className }: { title: string; progress: number; label: string | null; hint?: React.ReactNode; className?: string }) {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <Card className={cn("p-4 sm:p-6", className)} aria-busy="true">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <LoaderCircle className="size-5 animate-spin" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <div className="mt-3 flex items-center gap-3">
            <Progress value={value} aria-label={title} className="flex-1" />
            <span className="w-10 shrink-0 text-right text-sm font-medium tabular">{value}%</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">
            {label ?? "Aguarde um instante…"}
          </p>
          {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
    </Card>
  );
}

/** Faixa de aviso (informação, sucesso, atenção ou erro) usada nas etapas da migração. */
export function Banner({
  tone = "info",
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "positive" | "warning" | "negative" | "muted";
  icon: LucideIcon;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-info/30 bg-info/5 [--banner-icon:var(--color-info)]",
    positive: "border-positive/30 bg-positive/5 [--banner-icon:var(--color-positive)]",
    warning: "border-warning/40 bg-warning/5 [--banner-icon:var(--color-warning)]",
    negative: "border-destructive/30 bg-destructive/5 [--banner-icon:var(--color-destructive)]",
    muted: "bg-muted/40 [--banner-icon:var(--color-muted-foreground)]",
  } as const;
  return (
    <div
      role={tone === "negative" ? "alert" : "status"}
      className={cn("flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4", tones[tone], className)}
    >
      <div className="flex min-w-0 items-start gap-2.5 text-sm">
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--banner-icon)]" aria-hidden />
        <div className="min-w-0 break-words">
          <p className="font-semibold">{title}</p>
          {children && <div className="mt-0.5 text-muted-foreground">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}

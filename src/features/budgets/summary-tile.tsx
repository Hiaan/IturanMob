import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Indicador resumido (rótulo, valor em destaque e detalhe). Usado em orçamentos, metas e contas a pagar. */
export function SummaryTile({ label, value, children, className }: { label: string; value: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("min-w-0 p-4 sm:p-5", className)}>
      <p className="text-xs font-medium text-muted-foreground sm:text-[13px]">{label}</p>
      <p className="mt-2 break-words text-lg font-semibold leading-tight tracking-tight sm:text-2xl sm:leading-none">{value}</p>
      {children && <div className="mt-2 text-xs text-muted-foreground">{children}</div>}
    </Card>
  );
}

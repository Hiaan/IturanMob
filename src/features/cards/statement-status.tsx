import { CalendarClock, CheckCircle2, CircleDashed, CircleDot, Lock, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATEMENT_STATUS_LABELS, labelOf } from "@/lib/labels";

const META: Record<string, { icon: LucideIcon; variant: "info" | "warning" | "positive" | "negative" | "muted" | "secondary" }> = {
  OPEN: { icon: CircleDot, variant: "info" },
  CLOSED: { icon: Lock, variant: "warning" },
  PAID: { icon: CheckCircle2, variant: "positive" },
  PARTIAL: { icon: CircleDashed, variant: "warning" },
  OVERDUE: { icon: TriangleAlert, variant: "negative" },
  FUTURE: { icon: CalendarClock, variant: "muted" },
};

/** Situação da fatura: ícone + texto (nunca só a cor). */
export function StatementStatusBadge({ status, className }: { status: string; className?: string }) {
  const m = META[status] ?? META.OPEN!;
  const Icon = m.icon;
  return (
    <Badge variant={m.variant} className={className}>
      <Icon aria-hidden /> {labelOf(STATEMENT_STATUS_LABELS, status)}
    </Badge>
  );
}

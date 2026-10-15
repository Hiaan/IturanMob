import { Ban, CircleAlert, CircleCheck, Clock, CreditCard, SkipForward } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BillStatus } from "./types";

const STYLE: Record<BillStatus, { variant: "info" | "warning" | "brand" | "positive" | "muted"; Icon: typeof Clock }> = {
  PENDING: { variant: "info", Icon: Clock },
  OVERDUE: { variant: "warning", Icon: CircleAlert },
  POSTED: { variant: "brand", Icon: CreditCard },
  PAID: { variant: "positive", Icon: CircleCheck },
  SKIPPED: { variant: "muted", Icon: SkipForward },
  CANCELLED: { variant: "muted", Icon: Ban },
};

/** Status da conta com ícone + texto (a cor nunca é o único indicador). */
export function BillStatusBadge({ status, label }: { status: BillStatus; label: string }) {
  const { variant, Icon } = STYLE[status];
  return (
    <Badge variant={variant}>
      <Icon aria-hidden /> {label}
    </Badge>
  );
}

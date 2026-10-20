import {
  ArrowLeftRight,
  Bell,
  CalendarClock,
  ChartColumn,
  CircleAlert,
  CreditCard,
  Gauge,
  Inbox,
  Info,
  MessageCircleWarning,
  PiggyBank,
  Receipt,
  Repeat,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { notificationPriority } from "@/lib/notification-meta";

const ICONS: Record<string, LucideIcon> = {
  TRANSACTION_CREATED: ArrowLeftRight,
  INCOME_CREATED: TrendingUp,
  CONFIRMATION_REQUIRED: Inbox,
  BUDGET_THRESHOLD: Gauge,
  BILL_DUE: CalendarClock,
  BILL_OVERDUE: CircleAlert,
  STATEMENT_AVAILABLE: Receipt,
  STATEMENT_DUE: CreditCard,
  WEEKLY_REPORT: ChartColumn,
  MONTHLY_REPORT: ChartColumn,
  WHATSAPP_CONNECTION_FAILED: MessageCircleWarning,
  INCOME_GOAL: TrendingUp,
  GOAL_PROGRESS: PiggyBank,
  CASH_SHORTFALL: TrendingDown,
  SUBSCRIPTION_FOUND: Repeat,
  SYSTEM: Info,
};

/** Ícone do tipo de notificação; vencidas em destaque de aviso e "vence hoje" em informação. */
export function NotificationIcon({ type, data, className }: { type: string; data?: unknown; className?: string }) {
  const Icon = ICONS[type] ?? Bell;
  const priority = notificationPriority(type, data);
  const tone = priority === 0 ? "bg-warning/12 text-warning" : priority === 1 ? "bg-info/12 text-info" : type === "INCOME_GOAL" || type === "GOAL_PROGRESS" ? "bg-positive/12 text-positive" : "bg-muted text-muted-foreground";
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", tone, className)} aria-hidden>
      <Icon className="size-4" />
    </span>
  );
}

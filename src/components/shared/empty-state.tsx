import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({ icon: Icon, title, description, action, className }: { icon: LucideIcon; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center", className)}>
      <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
        <Icon className="size-6" />
      </span>
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

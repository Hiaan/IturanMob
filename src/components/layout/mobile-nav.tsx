"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, LayoutDashboard, Menu, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { NAV_GROUPS, isActive } from "./nav";
import { useState } from "react";

export function MobileNav({ onQuickAdd, pendingCount }: { onQuickAdd: () => void; pendingCount: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const item = (href: string, label: string, Icon: typeof LayoutDashboard) => {
    const active = isActive(pathname, href);
    return (
      <Link href={href} className={cn("flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium", active ? "text-brand" : "text-muted-foreground")} aria-current={active ? "page" : undefined}>
        <Icon className="size-5" />
        {label}
      </Link>
    );
  };
  return (
    <nav className="safe-bottom px-safe fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur lg:hidden" aria-label="Navegação">
      <div className="mx-auto flex max-w-lg items-stretch px-2">
        {item("/", "Início", LayoutDashboard)}
        {item("/transacoes", "Transações", ArrowLeftRight)}
        <div className="flex flex-1 items-center justify-center">
          <button
            type="button"
            onClick={onQuickAdd}
            className="-mt-6 flex size-14 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-lg shadow-emerald-900/25 transition active:scale-95"
            aria-label="Novo lançamento"
          >
            <Plus className="size-6" />
          </button>
        </div>
        {item("/assistente", "Isa", Sparkles)}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button type="button" className="relative flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium text-muted-foreground">
              <Menu className="size-5" />
              Menu
              {pendingCount > 0 && <span className="absolute right-4 top-1.5 size-2 rounded-full bg-brand" aria-label={`${pendingCount} pendências`} />}
            </button>
          </SheetTrigger>
          <SheetContent side="bottom">
            <SheetHeader>
              <SheetTitle>Menu</SheetTitle>
            </SheetHeader>
            <div className="grid max-h-[70dvh] gap-4 overflow-y-auto overscroll-contain px-5">
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{group.label}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {group.items.map((it) => (
                      <Link
                        key={it.href}
                        href={it.href}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "relative flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center text-xs font-medium",
                          isActive(pathname, it.href) ? "border-brand/40 bg-accent text-accent-foreground" : "bg-card",
                        )}
                      >
                        <it.icon className="size-5" />
                        {it.label}
                        {it.badge === "pending" && pendingCount > 0 && (
                          <span className="absolute right-2 top-2 rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white">{pendingCount}</span>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}

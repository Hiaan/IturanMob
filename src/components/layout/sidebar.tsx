"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_GROUPS, isActive } from "./nav";

export function Sidebar({ collapsed, onToggle, pendingCount }: { collapsed: boolean; onToggle: () => void; pendingCount: number }) {
  const pathname = usePathname();
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-300 lg:flex",
        collapsed ? "w-[76px]" : "w-64",
      )}
      aria-label="Navegação principal"
    >
      <div className={cn("flex h-16 items-center gap-3 border-b border-sidebar-border px-5", collapsed && "justify-center px-0")}>
        <span className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg shadow-emerald-900/30">
          <Wallet className="size-5" />
        </span>
        {!collapsed && (
          <div className="leading-tight">
            <p className="text-[15px] font-semibold text-white">Finance AI</p>
            <p className="text-[11px] text-sidebar-muted">Finanças da família</p>
          </div>
        )}
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-5">
            {!collapsed && <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">{group.label}</p>}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                const badge = item.badge === "pending" && pendingCount > 0 ? pendingCount : null;
                const link = (
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                      active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-white/5 hover:text-white",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-emerald-400" aria-hidden />}
                    <item.icon className={cn("size-[18px] shrink-0", active ? "text-emerald-300" : "text-sidebar-muted group-hover:text-white")} />
                    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                    {badge !== null && (
                      <span
                        className={cn(
                          "rounded-full bg-emerald-500 px-1.5 text-[11px] font-semibold leading-5 text-white tabular",
                          collapsed && "absolute right-2 top-1.5 px-1 text-[10px] leading-4",
                        )}
                      >
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </Link>
                );
                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <button
          type="button"
          onClick={onToggle}
          className={cn("flex h-9 w-full items-center gap-2 rounded-lg px-3 text-xs text-sidebar-muted transition hover:bg-white/5 hover:text-white", collapsed && "justify-center px-0")}
          aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
        >
          <ChevronLeft className={cn("size-4 transition-transform", collapsed && "rotate-180")} />
          {!collapsed && "Recolher menu"}
        </button>
      </div>
    </aside>
  );
}

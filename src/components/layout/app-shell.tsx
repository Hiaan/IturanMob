"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/lib/client/use-realtime";
import { useMe } from "@/features/me/use-me";
import { QuickAddDialog } from "@/features/transactions/quick-add-dialog";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { GlobalSearch } from "./global-search";
import { NotificationsBell } from "./notifications-bell";
import { UserMenu } from "./user-menu";
import { InstallHint } from "@/components/pwa/install-hint";
import { NotificationPopups } from "@/features/notifications/notification-popups";

export interface ShellUser {
  name: string;
  email: string;
  color: string;
  role: string;
  householdName: string;
}

const COLLAPSE_KEY = "fa:sidebar-collapsed";

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const realtime = useRealtime();
  const me = useMe();
  const pendingCount = me.data?.pending.total ?? 0;

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // armazenamento indisponível
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setQuickAddOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // ignore
      }
      return !c;
    });
  };

  return (
    <div className="flex min-h-dvh px-safe">
      <Sidebar collapsed={collapsed} onToggle={toggle} pendingCount={pendingCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="pt-safe sticky top-0 z-30 flex h-[calc(4rem+var(--safe-top))] items-center gap-3 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
          <div className="min-w-0 flex-1 lg:hidden">
            <p className="truncate text-sm font-semibold">{user.householdName}</p>
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden h-10 w-full max-w-md items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground shadow-xs transition hover:border-ring/50 lg:flex"
          >
            <Search className="size-4" />
            <span className="flex-1 text-left">Buscar transações, valores, categorias…</span>
            <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px]">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`hidden size-2 rounded-full sm:block ${realtime === "live" ? "bg-emerald-500" : realtime === "connecting" ? "bg-amber-400" : "bg-slate-400"}`}
                  aria-label={realtime === "live" ? "Atualização em tempo real ativa" : "Atualização em tempo real indisponível"}
                />
              </TooltipTrigger>
              <TooltipContent>{realtime === "live" ? "Atualização em tempo real ativa" : realtime === "connecting" ? "Conectando ao tempo real…" : "Tempo real indisponível — os dados continuam acessíveis"}</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSearchOpen(true)} aria-label="Buscar">
              <Search className="size-5" />
            </Button>
            <Button variant="brand" className="hidden sm:inline-flex" onClick={() => setQuickAddOpen(true)}>
              <Plus /> Novo lançamento
            </Button>
            <NotificationsBell />
            <UserMenu {...user} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-[calc(7rem+var(--safe-bottom))] pt-6 sm:px-6 lg:px-8 lg:pb-10">
          <InstallHint />
          {children}
        </main>
      </div>
      <MobileNav onQuickAdd={() => setQuickAddOpen(true)} pendingCount={pendingCount} />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <QuickAddDialog open={quickAddOpen} onOpenChange={setQuickAddOpen} />
      <NotificationPopups />
    </div>
  );
}

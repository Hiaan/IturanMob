"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { LogOut, Monitor, MonitorSmartphone, Moon, Settings, Sun } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MemberAvatar } from "@/components/ui/avatar";
import { MEMBER_ROLE_LABELS, labelOf } from "@/lib/labels";
import { usePwaEnvironment } from "@/lib/client/pwa";
import { INSTALL_SECTION_HREF } from "@/components/pwa/install-instructions";

export function UserMenu({ name, email, color, role, householdName }: { name: string; email: string; color: string; role: string; householdName: string }) {
  const { setTheme, theme } = useTheme();
  const pwa = usePwaEnvironment();
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch" } });
    window.location.href = "/login";
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Menu do usuário">
        <MemberAvatar name={name} color={color} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-semibold text-foreground">{name}</p>
          <p className="truncate text-xs">{email}</p>
          <p className="mt-1 text-xs">
            {householdName} · {labelOf(MEMBER_ROLE_LABELS, role)}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Tema</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setTheme("light")}>
          <Sun /> Claro {theme === "light" && "✓"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme("dark")}>
          <Moon /> Escuro {theme === "dark" && "✓"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme("system")}>
          <Monitor /> Automático {theme === "system" && "✓"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/configuracoes">
            <Settings /> Configurações
          </Link>
        </DropdownMenuItem>
        {pwa && !pwa.standalone && (
          <DropdownMenuItem asChild>
            <Link href={INSTALL_SECTION_HREF}>
              <MonitorSmartphone /> Instalar o app
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onSelect={logout}>
          <LogOut /> Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

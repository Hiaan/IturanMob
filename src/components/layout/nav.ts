import {
  ArrowLeftRight,
  BarChart3,
  CalendarClock,
  CreditCard,
  Inbox,
  Landmark,
  Layers,
  LayoutDashboard,
  PiggyBank,
  Plug,
  Settings,
  Sparkles,
  Tags,
  Target,
  Upload,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "pending";
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Visão geral",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/transacoes", label: "Transações", icon: ArrowLeftRight },
      { href: "/pendencias", label: "Pendências", icon: Inbox, badge: "pending" },
    ],
  },
  {
    label: "Gestão",
    items: [
      { href: "/contas", label: "Contas", icon: Landmark },
      { href: "/cartoes", label: "Cartões", icon: CreditCard },
      { href: "/orcamentos", label: "Orçamentos", icon: PiggyBank },
      { href: "/metas", label: "Metas", icon: Target },
      { href: "/contas-a-pagar", label: "Contas a pagar", icon: CalendarClock },
      { href: "/gastos-fixos", label: "Gastos fixos", icon: Layers },
    ],
  },
  {
    label: "Inteligência",
    items: [
      { href: "/assistente", label: "Assistente IA", icon: Sparkles },
      { href: "/relatorios", label: "Relatórios", icon: BarChart3 },
    ],
  },
  {
    label: "Ajustes",
    items: [
      { href: "/categorias", label: "Categorias", icon: Tags },
      { href: "/integracoes", label: "Integrações", icon: Plug },
      { href: "/importacao", label: "Importação", icon: Upload },
      { href: "/configuracoes", label: "Configurações", icon: Settings },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

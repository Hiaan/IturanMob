import {
  Baby,
  Banknote,
  Bike,
  BookOpen,
  Briefcase,
  Bus,
  Car,
  CirclePlus,
  Coffee,
  Dog,
  Dumbbell,
  Ellipsis,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  HandCoins,
  HeartPulse,
  House,
  Laptop,
  Music,
  Package,
  Palmtree,
  PiggyBank,
  Pill,
  Plane,
  Receipt,
  Repeat,
  Scissors,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Tag,
  TrendingUp,
  Tv,
  Utensils,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Mapa de nomes de ícones (padrão lucide, kebab-case) usados nas categorias → componente. */
export const CATEGORY_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  utensils: { icon: Utensils, label: "Alimentação" },
  "shopping-cart": { icon: ShoppingCart, label: "Mercado" },
  coffee: { icon: Coffee, label: "Café" },
  house: { icon: House, label: "Casa" },
  zap: { icon: Zap, label: "Energia" },
  wrench: { icon: Wrench, label: "Manutenção" },
  car: { icon: Car, label: "Carro" },
  fuel: { icon: Fuel, label: "Combustível" },
  bus: { icon: Bus, label: "Transporte público" },
  bike: { icon: Bike, label: "Bicicleta" },
  plane: { icon: Plane, label: "Viagem" },
  "heart-pulse": { icon: HeartPulse, label: "Saúde" },
  pill: { icon: Pill, label: "Medicamentos" },
  dumbbell: { icon: Dumbbell, label: "Academia" },
  baby: { icon: Baby, label: "Família" },
  dog: { icon: Dog, label: "Pets" },
  "graduation-cap": { icon: GraduationCap, label: "Educação" },
  "book-open": { icon: BookOpen, label: "Livros" },
  "shopping-bag": { icon: ShoppingBag, label: "Compras" },
  shirt: { icon: Shirt, label: "Vestuário" },
  scissors: { icon: Scissors, label: "Beleza" },
  sparkles: { icon: Sparkles, label: "Cuidados" },
  gift: { icon: Gift, label: "Presentes" },
  palmtree: { icon: Palmtree, label: "Lazer" },
  "gamepad-2": { icon: Gamepad2, label: "Jogos" },
  music: { icon: Music, label: "Música" },
  tv: { icon: Tv, label: "Streaming" },
  smartphone: { icon: Smartphone, label: "Celular" },
  laptop: { icon: Laptop, label: "Tecnologia" },
  repeat: { icon: Repeat, label: "Assinaturas" },
  receipt: { icon: Receipt, label: "Contas" },
  package: { icon: Package, label: "Encomendas" },
  briefcase: { icon: Briefcase, label: "Trabalho" },
  banknote: { icon: Banknote, label: "Dinheiro" },
  "hand-coins": { icon: HandCoins, label: "Rendimentos" },
  "piggy-bank": { icon: PiggyBank, label: "Poupança" },
  "trending-up": { icon: TrendingUp, label: "Investimentos" },
  "plus-circle": { icon: CirclePlus, label: "Outras receitas" },
  ellipsis: { icon: Ellipsis, label: "Outros" },
  tag: { icon: Tag, label: "Etiqueta" },
};

export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_ICONS);

/** Paleta sugerida para categorias (o usuário também pode escolher qualquer cor). */
export const CATEGORY_COLORS = [
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#a855f7",
  "#6366f1",
  "#0ea5e9",
  "#14b8a6",
  "#10b981",
  "#22c55e",
  "#84cc16",
  "#eab308",
  "#f59e0b",
  "#78716c",
  "#64748b",
  "#0f766e",
  "#1e3a5f",
];

export function categoryIconComponent(name: string | null | undefined): LucideIcon {
  return (name && CATEGORY_ICONS[name]?.icon) || Tag;
}

/** Bolha colorida com o ícone da categoria (a cor nunca é o único indicador: o nome acompanha). */
export function CategoryIcon({
  icon,
  color,
  className,
  size = "md",
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const Icon = categoryIconComponent(icon);
  const c = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#64748b";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl",
        size === "sm" && "size-7 rounded-lg [&_svg]:size-3.5",
        size === "md" && "size-9 [&_svg]:size-4",
        size === "lg" && "size-11 [&_svg]:size-5",
        className,
      )}
      style={{ backgroundColor: `${c}1f`, color: c }}
    >
      <Icon />
    </span>
  );
}

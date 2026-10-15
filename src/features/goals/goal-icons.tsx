import { Baby, Car, GraduationCap, Gift, Heart, House, Laptop, PiggyBank, Plane, Shield, Target, Umbrella, type LucideIcon } from "lucide-react";

/** Ícones disponíveis para metas (o nome é gravado em FinancialGoal.icon). */
export const GOAL_ICONS: Array<{ name: string; label: string; Icon: LucideIcon }> = [
  { name: "target", label: "Alvo", Icon: Target },
  { name: "plane", label: "Viagem", Icon: Plane },
  { name: "shield", label: "Reserva", Icon: Shield },
  { name: "house", label: "Casa", Icon: House },
  { name: "car", label: "Carro", Icon: Car },
  { name: "graduation-cap", label: "Educação", Icon: GraduationCap },
  { name: "laptop", label: "Eletrônicos", Icon: Laptop },
  { name: "piggy-bank", label: "Poupança", Icon: PiggyBank },
  { name: "heart", label: "Saúde", Icon: Heart },
  { name: "gift", label: "Presente", Icon: Gift },
  { name: "baby", label: "Filhos", Icon: Baby },
  { name: "umbrella", label: "Imprevistos", Icon: Umbrella },
];

export const GOAL_COLORS = ["#059669", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#ca8a04", "#475569"];

export function goalIcon(name: string): LucideIcon {
  return GOAL_ICONS.find((i) => i.name === name)?.Icon ?? Target;
}

export function GoalIconBadge({ icon, color, className = "size-10" }: { icon: string; color: string; className?: string }) {
  const Icon = goalIcon(icon);
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-xl ${className}`} style={{ backgroundColor: `${color}1f`, color }} aria-hidden>
      <Icon className="size-5" />
    </span>
  );
}

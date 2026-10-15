import { CircleDollarSign, Landmark, PiggyBank, Smartphone, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Ícone por tipo de conta (o nome é salvo no campo `icon` da conta). */
export const ACCOUNT_TYPE_ICON: Record<string, { name: string; icon: LucideIcon }> = {
  CHECKING: { name: "landmark", icon: Landmark },
  SAVINGS: { name: "piggy-bank", icon: PiggyBank },
  WALLET: { name: "wallet", icon: Wallet },
  INVESTMENT: { name: "trending-up", icon: TrendingUp },
  DIGITAL: { name: "smartphone", icon: Smartphone },
  OTHER: { name: "circle-dollar-sign", icon: CircleDollarSign },
};

const BY_NAME: Record<string, LucideIcon> = Object.fromEntries(Object.values(ACCOUNT_TYPE_ICON).map((v) => [v.name, v.icon]));

export const ACCOUNT_COLORS = ["#0f766e", "#059669", "#0ea5e9", "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#db2777", "#e11d48", "#ea580c", "#d97706", "#65a30d", "#475569", "#0b2545"];

export function AccountIcon({ type, icon, color, size = "md", className }: { type: string; icon?: string | null; color: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = ACCOUNT_TYPE_ICON[type]?.icon ?? (icon ? BY_NAME[icon] : undefined) ?? Landmark;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl text-white shadow-sm",
        size === "sm" && "size-8 rounded-lg [&_svg]:size-4",
        size === "md" && "size-10 [&_svg]:size-5",
        size === "lg" && "size-12 [&_svg]:size-6",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      <Icon />
    </span>
  );
}

/** Seletor de cor por amostras (com rótulo acessível). */
export function ColorSwatches({ value, onChange, colors, label = "Cor" }: { value: string; onChange: (c: string) => void; colors: string[]; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          aria-label={`Cor ${c}`}
          onClick={() => onChange(c)}
          className={cn(
            "size-7 rounded-full border-2 border-transparent outline-none ring-offset-2 ring-offset-card transition focus-visible:ring-2 focus-visible:ring-ring",
            value.toLowerCase() === c.toLowerCase() && "ring-2 ring-foreground",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="relative flex size-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed text-[10px] text-muted-foreground" title="Outra cor">
        <span aria-hidden>+</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Escolher outra cor" />
      </label>
    </div>
  );
}

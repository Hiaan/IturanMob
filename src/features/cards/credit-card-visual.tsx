import { Lock, Nfc } from "lucide-react";
import { cn } from "@/lib/utils";

function hexToRgb(hex: string): [number, number, number] {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "1e3a5f";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function shade(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(factor < 0 ? c * (1 + factor) : c + (255 - c) * factor)));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/** Luminância relativa (WCAG) para escolher texto claro ou escuro sobre a cor do cartão. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Representação visual do cartão (cor, nome, emissor, bandeira e final). */
export function CreditCardVisual({
  name,
  issuer,
  brand,
  last4,
  holderName,
  color,
  privateCard,
  archived,
  className,
}: {
  name: string;
  issuer: string | null;
  brand: string | null;
  last4: string | null;
  holderName: string | null;
  color: string;
  privateCard?: boolean;
  archived?: boolean;
  className?: string;
}) {
  const light = luminance(color) > 0.45;
  return (
    <div
      className={cn("relative isolate flex aspect-[1.586] w-full flex-col justify-between overflow-hidden rounded-2xl p-5 shadow-lg", light ? "text-[#0b1b33]" : "text-white", archived && "grayscale-[60%]", className)}
      style={{ background: `linear-gradient(135deg, ${shade(color, 0.12)} 0%, ${color} 45%, ${shade(color, -0.45)} 100%)` }}
    >
      <span className="pointer-events-none absolute -right-16 -top-20 -z-10 size-56 rounded-full bg-white/10" aria-hidden />
      <span className="pointer-events-none absolute -bottom-24 -left-10 -z-10 size-56 rounded-full bg-black/10" aria-hidden />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn("truncate text-[11px] font-medium uppercase tracking-[0.14em]", light ? "text-black/60" : "text-white/70")}>{issuer || "Cartão de crédito"}</p>
          <p className="truncate text-lg font-semibold leading-tight">{name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {privateCard && <Lock className="size-4 opacity-80" aria-label="Cartão privado" />}
          <Nfc className="size-5 opacity-80" aria-hidden />
        </div>
      </div>
      <div aria-hidden className={cn("h-7 w-10 rounded-md", light ? "bg-black/15" : "bg-gradient-to-br from-amber-200/90 to-amber-400/80")} />
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          {last4 ? (
            <p className="font-mono text-base tracking-[0.2em] tabular" aria-label={`Final ${last4}`}>
              •••• {last4}
            </p>
          ) : (
            <p className={cn("text-xs", light ? "text-black/55" : "text-white/60")}>Final não informado</p>
          )}
          <p className={cn("mt-0.5 truncate text-xs uppercase tracking-wide", light ? "text-black/60" : "text-white/75")}>{holderName ?? "Família"}</p>
        </div>
        {brand && <p className="shrink-0 text-sm font-bold italic tracking-tight">{brand}</p>}
      </div>
    </div>
  );
}

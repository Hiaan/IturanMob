"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { formatAmount } from "@/lib/money";

/**
 * Campo monetário estilo calculadora (digita-se da direita para a esquerda).
 * O valor é sempre um inteiro em centavos.
 */
export function MoneyInput({
  value,
  onChange,
  className,
  id,
  allowNegative = false,
  autoFocus,
  "aria-invalid": ariaInvalid,
  disabled,
  size = "default",
}: {
  value: number | null | undefined;
  onChange: (cents: number) => void;
  className?: string;
  id?: string;
  allowNegative?: boolean;
  autoFocus?: boolean;
  "aria-invalid"?: boolean;
  disabled?: boolean;
  size?: "default" | "lg";
}) {
  const cents = value ?? 0;
  const negative = cents < 0;
  return (
    <div
      className={cn(
        "flex items-center rounded-lg border border-input bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
        ariaInvalid && "border-destructive",
        size === "lg" ? "h-14 px-4" : "h-10 px-3",
        disabled && "opacity-50",
        className,
      )}
    >
      <span className={cn("mr-2 text-muted-foreground", size === "lg" ? "text-lg" : "text-sm")}>R$</span>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={ariaInvalid}
        className={cn("w-full bg-transparent text-right outline-none tabular", size === "lg" ? "text-2xl font-semibold tracking-tight" : "text-sm")}
        value={`${negative ? "-" : ""}${formatAmount(Math.abs(cents))}`}
        onChange={(e) => {
          const raw = e.target.value;
          const digits = raw.replace(/\D/g, "").slice(0, 12);
          const n = digits ? Number(digits) : 0;
          const neg = allowNegative && raw.includes("-");
          onChange(neg ? -n : n);
        }}
        onKeyDown={(e) => {
          if (allowNegative && e.key === "-") {
            e.preventDefault();
            onChange(-cents);
          }
        }}
      />
    </div>
  );
}

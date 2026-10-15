"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[5px] border border-input bg-card shadow-xs outline-none transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };

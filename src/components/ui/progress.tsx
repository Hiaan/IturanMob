"use client";

import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Progress({ className, value, indicatorClassName, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)} value={v} {...props}>
      <ProgressPrimitive.Indicator className={cn("h-full w-full flex-1 rounded-full bg-brand transition-transform duration-500", indicatorClassName)} style={{ transform: `translateX(-${100 - v}%)` }} />
    </ProgressPrimitive.Root>
  );
}

export { Progress };

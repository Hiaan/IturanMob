import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/** Campo de formulário com rótulo, ajuda e mensagem de erro acessível. */
function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
  required,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  error?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className={cn("grid gap-1.5", className)}>
      {label && (
        <Label htmlFor={htmlFor} className="text-[13px]">
          {label}
          {required && <span className="text-destructive" aria-hidden>*</span>}
        </Label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export { Field };

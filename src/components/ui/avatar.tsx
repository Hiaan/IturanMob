import { cn, initials } from "@/lib/utils";

function MemberAvatar({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  return (
    <span
      className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-card", className)}
      style={{ backgroundColor: color ?? "#0f766e" }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export { MemberAvatar };

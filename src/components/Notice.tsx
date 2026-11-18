import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline notice strip — the single visual family for slim contextual
 * banners (suggestions, recovery prompts, warnings). Three tones cover
 * the severities we use; pass the whole row as children.
 */
export function Notice({
  tone = "info",
  icon: Icon,
  className,
  children,
}: {
  tone?: "info" | "warning" | "action" | "danger";
  icon?: LucideIcon;
  className?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: "border-accent-foreground/25 bg-accent/40",
    warning: "border-warning/30 bg-warning/10",
    action: "border-primary/40 bg-primary/10",
    danger: "border-destructive/40 bg-destructive/10",
  };
  const iconTones = {
    info: "text-accent-foreground",
    warning: "text-warning",
    action: "text-primary",
    danger: "text-destructive",
  };
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-4 py-1.5 text-xs",
        tones[tone],
        className,
      )}
    >
      {Icon && <Icon className={cn("size-3.5 shrink-0", iconTones[tone])} />}
      {children}
    </div>
  );
}

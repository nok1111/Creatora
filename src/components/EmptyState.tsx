import type { LucideIcon } from "lucide-react";
import { SpotArt, type SpotKind } from "@/components/SpotArt";
import { cn } from "@/lib/utils";

/**
 * Shared empty state — icon tile + title + guidance copy + actions.
 * Every module uses this instead of bare text so empty screens always
 * tell the user what the feature does and what to do next.
 */
export function EmptyState({
  icon: Icon,
  art,
  title,
  body,
  action,
  secondary,
  tone = "primary",
  compact = false,
}: {
  icon: LucideIcon;
  /** Optional spot illustration — replaces the icon tile when set. */
  art?: SpotKind;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  tone?: "primary" | "accent" | "success";
  compact?: boolean;
}) {
  const tones = {
    primary: "bg-primary/15 text-primary",
    accent: "bg-accent text-accent-foreground",
    success: "bg-success/15 text-success",
  };
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-3 text-center",
        compact ? "p-4" : "p-10",
      )}
    >
      {art ? (
        <SpotArt kind={art} className={compact ? "h-14" : undefined} />
      ) : (
        <div className={cn("flex items-center justify-center rounded-2xl", tones[tone], compact ? "size-10" : "size-14")}>
          <Icon className={compact ? "size-5" : "size-7"} />
        </div>
      )}
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{body}</div>
      </div>
      <div className="flex gap-2">
        {action && (
          <button
            onClick={action.onClick}
            className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-raise transition-transform hover:scale-[1.02] active:scale-95"
          >
            {action.label}
          </button>
        )}
        {secondary && (
          <button
            onClick={secondary.onClick}
            className="rounded-lg border border-border bg-surface-2 px-4 py-1.5 text-xs text-muted-foreground hover:bg-surface-3 hover:text-foreground"
          >
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}

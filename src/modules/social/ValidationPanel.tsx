import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { useNavigate } from "react-router-dom";
import {
  PLATFORM_LABEL,
  type Finding,
  type SocialPlatform,
} from "@/lib/social-types";
import { cn } from "@/lib/utils";
import { useOpenInEditor } from "@/lib/open-in-editor";

const ICON: Record<Finding["severity"], React.ReactNode> = {
  error: <XCircle className="size-3.5 text-destructive" />,
  warning: <AlertTriangle className="size-3.5 text-warning" />,
  recommendation: <Info className="size-3.5 text-blue-400" />,
  info: <Info className="size-3.5 text-muted-foreground" />,
  passed: <CheckCircle2 className="size-3.5 text-success" />,
};

/** Validation Center — per-target findings with fix actions. */
export function ValidationPanel({
  postId,
  onFix,
}: {
  postId: string;
  /** Host-specific handler; return true when the fix was handled in-place. */
  onFix?: (f: Finding, targetId: string) => boolean | void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { openById, run } = useOpenInEditor();
  const { data } = useQuery({
    queryKey: ["validate-post", postId],
    queryFn: () => api.validateSocialPost(postId),
  });
  const post = useQuery({
    queryKey: ["social-post", postId],
    queryFn: () => api.getSocialPost(postId),
  });
  if (!data) return null;

  const go = (f: Finding, targetId: string) => {
    if (onFix?.(f, targetId)) return;
    const action = f.fixAction;
    if (action === "openFormats") {
      // Load the exact project linked to this post before showing the editor.
      const pid = post.data?.projectId;
      if (pid) run(() => openById(pid));
      else navigate("/editor");
    }
  };

  const errors = data.targets
    .flatMap((t) => t.findings)
    .filter((f) => f.severity === "error").length;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">{t("social.preflight")}</span>
        <span className="text-[10px] text-muted-foreground">
          {t("social.rulesInfo", {
            version: data.rulesVersion,
            updated: data.rulesUpdated,
          })}
          {errors > 0 && (
            <span className="ml-1 text-destructive">
              · {t("social.nErrors", { count: errors })}
            </span>
          )}
        </span>
      </div>
      {data.targets.map((tg) => (
        <div key={tg.targetId} className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {PLATFORM_LABEL[tg.platform as SocialPlatform] ?? tg.platform}
          </p>
          {tg.findings.map((f, i) => (
            <div
              key={i}
              className={cn(
                "flex items-start gap-2 rounded px-2 py-1 text-[11px]",
                f.severity === "error" && "bg-destructive/10",
                f.severity === "warning" && "bg-warning/15",
                f.severity === "recommendation" && "bg-blue-500/10",
                f.severity === "info" && "bg-muted/40",
                f.severity === "passed" && "bg-success/15",
              )}
            >
              <span className="mt-px shrink-0">{ICON[f.severity]}</span>
              <div className="min-w-0 flex-1">
                <p>
                  {t(`find.${f.code}`, { ...(f.params ?? {}), defaultValue: f.message })}
                </p>
                {f.fix && (
                  <button
                    onClick={() => go(f, tg.targetId)}
                    className="mt-0.5 flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                  >
                    {t(`find.${f.code}_fix`, { defaultValue: f.fix })}{" "}
                    <ArrowRight className="size-2.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

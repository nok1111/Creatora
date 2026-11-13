import { useQuery } from "@tanstack/react-query";
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

const ICON: Record<Finding["severity"], React.ReactNode> = {
  error: <XCircle className="size-3.5 text-red-400" />,
  warning: <AlertTriangle className="size-3.5 text-amber-400" />,
  recommendation: <Info className="size-3.5 text-blue-400" />,
  info: <Info className="size-3.5 text-muted-foreground" />,
  passed: <CheckCircle2 className="size-3.5 text-green-400" />,
};

/** Validation Center — per-target findings with fix actions. */
export function ValidationPanel({ postId }: { postId: string }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["validate-post", postId],
    queryFn: () => api.validateSocialPost(postId),
  });
  if (!data) return null;

  const go = (action: string) => {
    if (action === "openFormats") navigate("/editor");
    // openCaptions/pickFile/connectAccount stay in-module — the composer
    // already shows caption + file pickers; accounts live in the tab.
  };

  const errors = data.targets
    .flatMap((t) => t.findings)
    .filter((f) => f.severity === "error").length;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">Pre-flight check</span>
        <span className="text-[10px] text-muted-foreground">
          rules v{data.rulesVersion} · updated {data.rulesUpdated}
          {errors > 0 && (
            <span className="ml-1 text-red-400">· {errors} error(s)</span>
          )}
        </span>
      </div>
      {data.targets.map((t) => (
        <div key={t.targetId} className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {PLATFORM_LABEL[t.platform as SocialPlatform] ?? t.platform}
          </p>
          {t.findings.map((f, i) => (
            <div
              key={i}
              className={cn(
                "flex items-start gap-2 rounded px-2 py-1 text-[11px]",
                f.severity === "error" && "bg-red-500/10",
                f.severity === "warning" && "bg-amber-500/10",
                f.severity === "recommendation" && "bg-blue-500/10",
                f.severity === "info" && "bg-muted/40",
                f.severity === "passed" && "bg-green-500/10",
              )}
            >
              <span className="mt-px shrink-0">{ICON[f.severity]}</span>
              <div className="min-w-0 flex-1">
                <p>{f.message}</p>
                {f.fix && (
                  <button
                    onClick={() => go(f.fixAction)}
                    className="mt-0.5 flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                  >
                    {f.fix} <ArrowRight className="size-2.5" />
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

import { toast } from "sonner";
import i18n from "@/i18n";
import { AppError } from "@/lib/ipc";

/**
 * Central error voice: every technical failure shown to the user goes through
 * here. The title is an understandable explanation (what happened + the user's
 * work is intact when true); the technical detail stays in `description` for
 * diagnostics. Never hides real errors, never fakes success.
 */
export function reportError(e: unknown, context?: string) {
  const err = e instanceof AppError ? e : AppError.from(e);
  const t = (k: string) => i18n.t(`err.${k}`);

  let key = "generic";
  if (err.code === "not_found") key = "notFound";
  else if (err.code === "db") key = "db";
  else if (err.code === "invalid_input") key = "invalidInput";
  else if (err.code === "io" || /permission denied|acceso denegado|os error 5/i.test(err.message))
    key = "ioPermission";
  else if (err.code === "io") key = "io";
  else if (/ffmpeg|ffprobe/i.test(err.message)) key = "ffmpeg";
  else if (/whisper|model/i.test(err.message)) key = "transcribe";
  else if (/oauth|token|publish|api/i.test(err.message)) key = "social";
  else if (/network|fetch|connect|timed? ?out/i.test(err.message)) key = "network";

  const title = context ? `${context}: ${t(key)}` : t(key);
  // description keeps the raw technical message for diagnosis.
  toast.error(title, { description: err.message });
}

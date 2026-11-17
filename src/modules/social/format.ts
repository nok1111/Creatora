import { api } from "@/lib/ipc";
import { reportError } from "@/lib/errors";

/** SQLite `datetime('now')` stamps are UTC "YYYY-MM-DD HH:MM:SS" — show them in the user's locale/timezone. */
export function fmtDbTime(ts: string | null | undefined, lang: string): string {
  if (!ts) return "—";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString(lang);
}

/** Open a published post in the default browser (http(s) only, enforced in Rust). */
export async function openExternal(url: string): Promise<void> {
  try {
    await api.openExternalUrl(url);
  } catch (e) {
    reportError(e);
  }
}

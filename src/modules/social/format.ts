/** SQLite `datetime('now')` stamps are UTC "YYYY-MM-DD HH:MM:SS" — show them in the user's locale/timezone. */
export function fmtDbTime(ts: string | null | undefined, lang: string): string {
  if (!ts) return "—";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString(lang);
}

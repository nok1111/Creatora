import type { FxEntry, FxParam } from "@/lib/fx/manifest";

/** Packed 0xRRGGBB number ↔ "#rrggbb". */
const toHex = (n: number) => "#" + Math.round(n).toString(16).padStart(6, "0");

/**
 * Parameter controls generated from the manifest: the control type follows
 * the param type, so a new effect needs no UI code.
 */
export function FxParams({
  entry,
  values,
  onChange,
}: {
  entry: FxEntry;
  values: Record<string, number> | undefined;
  onChange: (key: string, value: number) => void;
}) {
  return (
    <>
      {entry.params.map((p: FxParam) => {
        const v = values?.[p.key] ?? p.def;
        return (
          <div key={p.key} className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 truncate text-[10px] text-muted-foreground" title={p.label}>
              {p.label}
            </span>
            {p.type === "enum" ? (
              <select
                className="flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
                value={v}
                onChange={(e) => onChange(p.key, Number(e.target.value))}
              >
                {p.options!.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            ) : p.type === "bool" ? (
              <input type="checkbox" checked={v >= 0.5} onChange={(e) => onChange(p.key, e.target.checked ? 1 : 0)} />
            ) : p.type === "color" ? (
              <input
                type="color"
                value={toHex(v)}
                onChange={(e) => onChange(p.key, parseInt(e.target.value.slice(1), 16))}
              />
            ) : (
              <>
                <input
                  type="range"
                  className="flex-1"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={v}
                  onChange={(e) => onChange(p.key, Number(e.target.value))}
                />
                <span className="w-14 text-right font-mono text-[10px]">
                  {v.toFixed((p.step ?? 0.01) >= 1 ? 0 : 2)}
                  {p.unit ? <span className="text-muted-foreground"> {p.unit}</span> : null}
                </span>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

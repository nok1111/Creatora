import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { clampRange } from "@/lib/repurpose";
import { cn } from "@/lib/utils";

export interface ManualRange {
  id: string;
  startMs: number;
  endMs: number;
}

/** Per-clip hue cycle — every stacked slider reads as its own clip. */
const HUES = [16, 210, 145, 275, 45, 330, 190, 95, 0, 250];
export const rangeColor = (i: number, alpha = 1) =>
  `hsla(${HUES[i % HUES.length]}, 75%, 55%, ${alpha})`;

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type Drag = { mode: "start" | "end" | "move"; grab: number } | null;

function SliderRow({
  index,
  range,
  durationMs,
  disabled,
  onChange,
}: {
  index: number;
  range: ManualRange;
  durationMs: number;
  disabled: boolean;
  onChange: (id: string, r: { startMs: number; endMs: number }) => void;
}) {
  const { t } = useTranslation();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag>(null);
  const len = range.endMs - range.startMs;
  const color = rangeColor(index);

  const msAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round((pct * durationMs) / 100) * 100;
  };

  const apply = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const ms = msAt(e.clientX);
    if (d.mode === "move") {
      const s = Math.min(Math.max(0, ms - d.grab), Math.max(0, durationMs - len));
      onChange(range.id, { startMs: s, endMs: s + len });
    } else {
      onChange(
        range.id,
        clampRange(d.mode === "start" ? ms : range.startMs, d.mode === "end" ? ms : range.endMs, durationMs),
      );
    }
  };

  const down = (mode: NonNullable<Drag>["mode"]) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, grab: msAt(e.clientX) - range.startMs };
  };
  const up = (e: React.PointerEvent) => {
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const nudge = (which: "start" | "end") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 5000 : 1000) * (e.key === "ArrowLeft" ? -1 : 1);
    onChange(
      range.id,
      clampRange(which === "start" ? range.startMs + step : range.startMs,
        which === "end" ? range.endMs + step : range.endMs, durationMs),
    );
  };

  const handleCls =
    "absolute top-0 z-10 h-full w-2.5 cursor-ew-resize rounded-sm bg-white/80 shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="size-2.5 rounded-sm" style={{ background: color }} />
        <span className="font-medium">{t("rp.clipN", { n: index + 1 })}</span>
        <span className="tabular-nums text-muted-foreground">
          {fmt(range.startMs)} → {fmt(range.endMs)} · {Math.round(len / 1000)} s
        </span>
      </div>
      <div
        ref={track}
        className={cn("relative h-7 select-none rounded-md bg-secondary/70", disabled && "opacity-50")}
        data-rp-track={range.id}
      >
        {/* body — drag to move */}
        <div
          className="absolute top-0 h-full cursor-grab rounded-md active:cursor-grabbing"
          style={{
            left: `${(range.startMs / durationMs) * 100}%`,
            width: `${(len / durationMs) * 100}%`,
            background: rangeColor(index, 0.55),
            border: `1px solid ${color}`,
          }}
          onPointerDown={down("move")}
          onPointerMove={apply}
          onPointerUp={up}
          onPointerCancel={up}
        />
        {/* handles — drag to resize */}
        {(["start", "end"] as const).map((w) => (
          <div
            key={w}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={`${t("rp.clipN", { n: index + 1 })} ${w === "start" ? t("rp.start") : t("rp.end")}`}
            aria-valuemin={0}
            aria-valuemax={durationMs}
            aria-valuenow={w === "start" ? range.startMs : range.endMs}
            className={handleCls}
            style={{ [w === "start" ? "left" : "right"]: `${((w === "start" ? range.startMs : durationMs - range.endMs) / durationMs) * 100}%` }}
            onPointerDown={down(w)}
            onPointerMove={apply}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={nudge(w)}
          />
        ))}
      </div>
    </div>
  );
}

/** Stacked per-clip range sliders over the source timeline + an overview strip. */
export function ManualTrim({
  durationMs,
  ranges,
  disabled,
  onChange,
}: {
  durationMs: number;
  ranges: ManualRange[];
  disabled: boolean;
  onChange: (id: string, r: { startMs: number; endMs: number }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-rp-manual>
      {/* overview: every clip as a colored notch on one ruler */}
      <div>
        <div className="relative h-8 rounded-md bg-secondary/70">
          {ranges.map((r, i) => (
            <div
              key={r.id}
              className="absolute rounded-sm"
              style={{
                left: `${(r.startMs / durationMs) * 100}%`,
                width: `${Math.max(0.4, ((r.endMs - r.startMs) / durationMs) * 100)}%`,
                top: `${3 + (i % 6) * 4}px`,
                height: 3,
                background: rangeColor(i),
              }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
          <span>0:00</span>
          <span>{fmt(durationMs / 2)}</span>
          <span>{fmt(durationMs)}</span>
        </div>
      </div>
      <div className="space-y-2.5">
        {ranges.map((r, i) => (
          <SliderRow key={r.id} index={i} range={r} durationMs={durationMs} disabled={disabled} onChange={onChange} />
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("rp.manualHint")}</p>
    </div>
  );
}

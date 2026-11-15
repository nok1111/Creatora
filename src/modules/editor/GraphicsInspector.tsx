import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlignCenter,
  AlignCenterVertical,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartVertical,
  Brush,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Diamond,
  Eye,
  EyeOff,
  Link2,
  Link2Off,
  Move,
  Play,
  Shapes,
  Sparkles,
  Type,
} from "lucide-react";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  alignClipTo,
  applyAnimationPreset,
  applyClipStyle,
  bindClipBrand,
  clearVersionClipOverrides,
  clipStylePayload,
  effectiveDoc,
  findClip,
  getVersion,
  removeKeyframe,
  setKeyframe,
  setVersionClipOverride,
  updateClip,
} from "@/lib/timeline-engine";
import { ANIM_PRESETS, supportsTextFx } from "@/lib/anim-presets";
import type { AnimatablePath } from "@/lib/effects";
import type { Clip } from "@/lib/project-types";
import { cn } from "@/lib/utils";

/** Shared style clipboard for copy/paste-style (session-scoped). */
let styleClipboard: ReturnType<typeof clipStylePayload> | null = null;

const PANEL_LABEL = "text-[10px] uppercase tracking-wide text-muted-foreground";
const FIELD =
  "rounded border border-border bg-background px-1 py-0.5 text-xs text-foreground";

/** Collapsible section with icon — design-studio grouping. */
function Section({
  icon: Icon,
  title,
  badge,
  defaultOpen = true,
  actions,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-border bg-surface-1">
      <div className="flex w-full items-center gap-2 px-2.5 py-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <Icon className="size-3.5 shrink-0 text-primary" />
          <span className={cn(PANEL_LABEL, "truncate")}>{title}</span>
          {badge && (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
              {badge}
            </span>
          )}
        </button>
        {actions}
        <button onClick={() => setOpen(!open)}>
          <ChevronDown
            className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")}
          />
        </button>
      </div>
      {open && <div className="space-y-2 border-t border-border/60 px-2.5 py-2.5">{children}</div>}
    </section>
  );
}

/**
 * Label + slider + editable number (+ optional keyframe toggle).
 * A drag or a typed edit runs inside one undo gesture — beginGesture on
 * pointer-down/focus, mutateInGesture during, endGesture on release/blur.
 */
function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onPatch,
  kfPath,
  kfAt,
  onToggleKey,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onPatch: (v: number, transient: boolean) => void;
  kfPath?: AnimatablePath;
  kfAt?: (p: AnimatablePath) => boolean;
  onToggleKey?: (p: AnimatablePath, cur: number) => void;
  format?: (v: number) => string;
}) {
  const { t } = useTranslation();
  const gesturing = useRef(false);
  /** Begin once (pointer-down, focus or first change) — always with the
      doc as it is right now; end on release/blur. One undo per edit. */
  const startG = () => {
    if (gesturing.current) return;
    gesturing.current = true;
    useEditor.getState().beginGesture();
    // Release-outside safety: element-scoped pointerup can be missed.
    const up = () => {
      window.removeEventListener("pointerup", up);
      gesturing.current = false;
      useEditor.getState().endGesture();
    };
    window.addEventListener("pointerup", up);
  };
  const endG = () => {
    if (!gesturing.current) return;
    gesturing.current = false;
    useEditor.getState().endGesture();
  };
  // Never leak an open gesture on unmount — a stale gestureBase would
  // silently swallow the history of the next document edit.
  useEffect(() => () => endG(), []);
  const shown = format ? format(value) : String(Math.round(value * 100) / 100);
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <input
        type="range"
        className="min-w-0 flex-1 accent-primary"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onPointerDown={startG}
        onChange={(e) => {
          startG();
          onPatch(Number(e.target.value), true);
        }}
        onKeyUp={endG}
        onBlur={endG}
      />
      <input
        type="number"
        className={cn(FIELD, "w-14 shrink-0 text-right")}
        step={step}
        value={shown}
        onFocus={startG}
        onChange={(e) => {
          startG();
          onPatch(Number(e.target.value), true);
        }}
        onBlur={endG}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {kfPath && onToggleKey && kfAt && (
        <button
          className={cn(
            "shrink-0 rounded p-0.5",
            kfAt(kfPath) ? "text-accent-foreground" : "text-muted-foreground/50 hover:text-foreground",
          )}
          title={t("editor.keyframe")}
          onClick={() => onToggleKey(kfPath, value)}
        >
          <Diamond className="size-3" />
        </button>
      )}
    </div>
  );
}

/** Native color well + optional brand-kit swatch strip. */
function ColorRow({
  label,
  value,
  onPatch,
  swatches,
}: {
  label: string;
  value: string;
  onPatch: (v: string) => void;
  swatches?: string[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <input
        type="color"
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent"
        value={value.slice(0, 7)}
        onChange={(e) => onPatch(e.target.value)}
      />
      <div className="flex min-w-0 flex-1 flex-wrap gap-1">
        {(swatches ?? []).map((c) => (
          <button
            key={c}
            className={cn(
              "size-4 rounded border",
              value.toLowerCase().startsWith(c.toLowerCase())
                ? "border-foreground"
                : "border-border/60 hover:border-muted-foreground",
            )}
            style={{ background: c }}
            title={c}
            onClick={() => onPatch(c)}
          />
        ))}
      </div>
    </div>
  );
}

const EASINGS = [
  ["linear", "linear"],
  ["easeOut", "out"],
  ["easeIn", "in"],
  ["easeInOut", "in·out"],
  ["backOut", "back"],
  ["bounceOut", "bounce"],
] as const;

const DIRS = [
  ["left", "←"],
  ["right", "→"],
  ["up", "↑"],
  ["down", "↓"],
] as const;

/**
 * Graphics design studio (ADR-027 + Fase 2): replaces the generic
 * property rows for text/shape clips with grouped, collapsible,
 * element-aware sections — Content & Type, Transform, Appearance,
 * Animation, Brand. Same engine ops underneath; nothing preview-only.
 */
export function GraphicsInspector({ clipId }: { clipId: string }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc)!;
  const mutate = useEditor((s) => s.mutate);
  const mutateInGesture = useEditor((s) => s.mutateInGesture);
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const playheadMs = useEditor((s) => s.playheadMs);

  const [animTab, setAnimTab] = useState<"in" | "loop" | "out">("in");
  const [presetId, setPresetId] = useState("fadeIn");
  const [dur, setDur] = useState(400);
  const [intensity, setIntensity] = useState(160);
  const [dir, setDir] = useState("left");
  const [easing, setEasing] = useState("easeOut");
  const [locked, setLocked] = useState(true);

  const version = activeVersionId ? getVersion(doc, activeVersionId) : undefined;
  const viewDoc = effectiveDoc(doc, activeVersionId);
  const hit = findClip(viewDoc, clipId);
  if (!hit) return null;
  const { clip } = hit;

  const hasText = clip.text != null;
  const style = clip.textStyle;
  const shape = clip.shape;
  const isLine = shape?.kind === "line";
  const kit = doc.brandKit;
  const bind = clip.brandBindings;
  const rel = playheadMs - clip.startMs;
  const canvas = version?.canvas ?? doc.canvas;

  const m = (transient: boolean) => (transient ? mutateInGesture : mutate);

  const patchTransform = (k: keyof Clip["transform"], v: number, transient = false) => {
    if (version) {
      m(transient)((d) =>
        setVersionClipOverride(d, version.id, clipId, {
          transform: { ...clip.transform, [k]: v },
        }),
      );
    } else {
      m(transient)((d) => updateClip(d, clipId, { transform: { [k]: v } }));
    }
  };

  const patchScale = (k: "scaleX" | "scaleY", v: number, transient: boolean) => {
    // Linked scales keep the current aspect ratio.
    const other = k === "scaleX" ? "scaleY" : "scaleX";
    const base = clip.transform;
    const next = { ...base, [k]: v };
    if (locked && base[k] !== 0) next[other] = base[other] * (v / base[k]);
    if (version) {
      m(transient)((d) => setVersionClipOverride(d, version.id, clipId, { transform: next }));
    } else {
      m(transient)((d) => updateClip(d, clipId, { transform: next }));
    }
  };

  const patchStyle = (k: string, v: unknown, transient = false) => {
    const next = { ...(style ?? {}), [k]: v };
    if (version) {
      m(transient)((d) =>
        setVersionClipOverride(d, version.id, clipId, { textStyle: next as never }),
      );
    } else {
      m(transient)((d) => updateClip(d, clipId, { textStyle: next as Clip["textStyle"] }));
    }
  };

  const patchShape = (p: Partial<NonNullable<Clip["shape"]>>) =>
    mutate((d) => updateClip(d, clipId, { shape: { ...clip.shape!, ...p } }));

  const patchText = (v: string) => {
    if (version) {
      mutate((d) => setVersionClipOverride(d, version.id, clipId, { text: v }));
    } else {
      mutate((d) => updateClip(d, clipId, { text: v }));
    }
  };

  const keyAt = (path: AnimatablePath) =>
    clip.keyframes[path]?.some((k) => k.tMs === Math.round(rel));

  const toggleKey = (path: AnimatablePath, current: number) => {
    if (version && path.startsWith("transform.")) {
      mutate((d) => {
        const cur = clip.keyframes[path] ?? [];
        const exists = cur.some((k) => k.tMs === Math.round(rel));
        const next = exists
          ? cur.filter((k) => k.tMs !== Math.round(rel))
          : [...cur, { tMs: Math.round(rel), v: current, ease: "linear" }];
        return setVersionClipOverride(d, version.id, clipId, {
          keyframes: { [path]: next },
        });
      });
    } else {
      mutate((d) =>
        keyAt(path)
          ? removeKeyframe(d, clipId, path, rel)
          : setKeyframe(d, clipId, path, rel, current),
      );
    }
  };

  const visiblePresets = ANIM_PRESETS.filter((p) => {
    if (animTab === "in") return p.category === "in";
    if (animTab === "out") return p.category === "out";
    return p.category === "loop" || p.category === "emphasis" || p.category === "transition";
  });

  const applyAnim = () =>
    mutate((d) =>
      applyAnimationPreset(d, clipId, presetId, {
        durationMs: dur,
        intensity,
        direction: dir,
        easing,
        versionId: activeVersionId,
      }),
    );

  const elementKind = shape ? shape.kind : hasText ? "text" : "clip";

  return (
    <div className="space-y-2.5">
      {/* Element header + utilities */}
      <div className="flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
          {shape ? <Shapes className="size-4" /> : <Type className="size-4" />}
        </div>
        <span className="min-w-0 flex-1 truncate text-xs font-medium capitalize">{elementKind}</span>
        {activeVersionId &&
          (() => {
            const v = doc.versions.find((x) => x.id === activeVersionId);
            return v?.clipOverrides[clipId] ? (
              <button
                className="rounded px-1 text-[9px] text-accent-foreground hover:bg-accent"
                title={t("gfxI.dropOverride")}
                onClick={() => mutate((d) => clearVersionClipOverrides(d, activeVersionId, clipId))}
              >
                re-sync
              </button>
            ) : null;
          })()}
        <button
          className="rounded p-1 hover:bg-accent"
          title={t("gfxI.copyStyle")}
          onClick={() => (styleClipboard = clipStylePayload(clip))}
        >
          <Copy className="size-3.5" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent disabled:opacity-40"
          title={t("gfxI.pasteStyle")}
          disabled={!styleClipboard}
          onClick={() => styleClipboard && mutate((d) => applyClipStyle(d, clipId, styleClipboard!))}
        >
          <ClipboardPaste className="size-3.5" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent"
          title={activeVersionId ? t("editor.hideInVersion") : t("editor.hideClip")}
          onClick={() =>
            mutate((d) => {
              if (activeVersionId) {
                const v = d.versions.find((x) => x.id === activeVersionId);
                if (!v) return d;
                const nn = JSON.parse(JSON.stringify(d)) as typeof d;
                const vv = nn.versions.find((x) => x.id === activeVersionId)!;
                const ov = (vv.clipOverrides[clipId] ??= {});
                ov.hidden = !(clip.hidden ?? false);
                return nn;
              }
              return updateClip(d, clipId, { hidden: !(clip.hidden ?? false) });
            })
          }
        >
          {clip.hidden ? <EyeOff className="size-3.5 text-warning" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {version && (
        <p className="text-[9px] italic text-accent-foreground/80">
          {t("versions.editingVersion", { name: version.name })}
        </p>
      )}

      {/* CONTENT + TYPOGRAPHY — only when the element carries text */}
      {hasText && (
        <Section icon={Type} title={t("gfxI.contentType")}>
          <textarea
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
            rows={2}
            value={clip.text ?? ""}
            onChange={(e) => patchText(e.target.value)}
          />
          {/* 3×3 anchor grid: row = vertical, col = horizontal */}
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{t("gfxI.anchor")}</span>
            <div className="grid grid-cols-3 overflow-hidden rounded-md border border-border">
              {(["top", "middle", "bottom"] as const).map((v) =>
                (["left", "center", "right"] as const).map((h) => {
                  const active = style?.alignH === h && style?.alignV === v;
                  return (
                    <button
                      key={v + h}
                      className={cn(
                        "size-6 border-[0.5px] border-border/50 transition-colors",
                        active ? "bg-primary text-primary-foreground" : "bg-surface-1 hover:bg-accent/50",
                      )}
                      title={`${v} ${h}`}
                      onClick={() => {
                        patchStyle("alignH", h);
                        patchStyle("alignV", v);
                      }}
                    >
                      <span
                        className={cn(
                          "mx-auto block size-1.5 rounded-sm",
                          active ? "bg-primary-foreground" : "bg-muted-foreground/60",
                        )}
                      />
                    </button>
                  );
                }),
              )}
            </div>
          </div>
          {style && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{t("gfxI.font")}</span>
                <select
                  className={cn(FIELD, "min-w-0 flex-1")}
                  value={style.fontFile ?? ""}
                  onChange={(e) => patchStyle("fontFile", e.target.value || null)}
                >
                  <option value="">{t("gfxI.fontDefault")}</option>
                  {(kit?.fonts ?? []).map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <SliderRow
                label={t("gfxI.size")}
                value={style.fontSizePx}
                min={6}
                max={Math.round(canvas.height / 4)}
                onPatch={(v, tr) => patchStyle("fontSizePx", Math.max(1, v), tr)}
              />
              <ColorRow
                label={t("gfxI.color")}
                value={style.color}
                onPatch={(v) => patchStyle("color", v)}
                swatches={kit?.colors}
              />
              <TypeExtras style={style} patchStyle={patchStyle} swatches={kit?.colors} />
            </>
          )}
        </Section>
      )}

      {/* TRANSFORM — sliders + numbers, linked scale, align row */}
      <Section icon={Move} title={t("gfxI.transform")} defaultOpen>
        <SliderRow label="X" value={clip.transform.x} min={-canvas.width} max={canvas.width} onPatch={(v, tr) => patchTransform("x", v, tr)} kfPath="transform.x" kfAt={keyAt} onToggleKey={toggleKey} />
        <SliderRow label="Y" value={clip.transform.y} min={-canvas.height} max={canvas.height} onPatch={(v, tr) => patchTransform("y", v, tr)} kfPath="transform.y" kfAt={keyAt} onToggleKey={toggleKey} />
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10px] text-muted-foreground" />
          <div className="flex-1" />
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={locked ? "Unlink scale X/Y" : "Link scale X/Y"}
            onClick={() => setLocked(!locked)}
          >
            {locked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}
          </button>
        </div>
        <SliderRow label={t("editor.propScaleX")} value={clip.transform.scaleX} min={0} max={4} step={0.01} onPatch={(v, tr) => patchScale("scaleX", v, tr)} kfPath="transform.scaleX" kfAt={keyAt} onToggleKey={toggleKey} format={(v) => v.toFixed(2)} />
        <SliderRow label={t("editor.propScaleY")} value={clip.transform.scaleY} min={0} max={4} step={0.01} onPatch={(v, tr) => patchScale("scaleY", v, tr)} kfPath="transform.scaleY" kfAt={keyAt} onToggleKey={toggleKey} format={(v) => v.toFixed(2)} />
        <SliderRow label={t("editor.propRotate")} value={clip.transform.rotationDeg} min={-180} max={180} onPatch={(v, tr) => patchTransform("rotationDeg", v, tr)} kfPath="transform.rotationDeg" kfAt={keyAt} onToggleKey={toggleKey} />
        <SliderRow label={t("editor.propOpacity")} value={clip.transform.opacity} min={0} max={1} step={0.01} onPatch={(v, tr) => patchTransform("opacity", Math.min(1, Math.max(0, v)), tr)} kfPath="transform.opacity" kfAt={keyAt} onToggleKey={toggleKey} format={(v) => `${Math.round(v * 100)}%`} />
        <div className="flex gap-0.5 pt-0.5">
          {(
            [
              ["left", AlignLeft],
              ["center", AlignCenter],
              ["right", AlignRight],
              ["top", AlignStartVertical],
              ["middle", AlignCenterVertical],
              ["bottom", AlignEndVertical],
            ] as const
          ).map(([a, Icon]) => (
            <button
              key={a}
              className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={`Align ${a}`}
              onClick={() => mutate((d) => alignClipTo(d, clipId, a, 40))}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      </Section>

      {/* APPEARANCE — shape elements */}
      {shape && (
        <Section icon={Brush} title={t("gfxI.appearance")}>
          <ColorRow
            label={t("gfxI.fill")}
            value={shape.fill}
            onPatch={(v) => patchShape({ fill: v })}
            swatches={kit?.colors}
          />
          <ColorRow
            label={t("gfxI.outline")}
            value={shape.outlineColor ?? "#ffffff"}
            onPatch={(v) =>
              patchShape({ outlineColor: v, outlineWidth: Math.max(1, shape.outlineWidth) })
            }
            swatches={kit?.colors}
          />
          <SliderRow
            label={t("gfxI.outlineW")}
            value={shape.outlineWidth}
            min={0}
            max={40}
            onPatch={(v, tr) =>
              m(tr)((d) =>
                updateClip(d, clipId, { shape: { ...clip.shape!, outlineWidth: Math.max(0, v) } }),
              )
            }
          />
          {isLine ? (
            <>
              <SliderRow
                label={t("gfxI.length")}
                value={shape.widthPx}
                min={1}
                max={canvas.width}
                onPatch={(v, tr) =>
                  m(tr)((d) =>
                    updateClip(d, clipId, { shape: { ...clip.shape!, widthPx: Math.max(1, v) } }),
                  )
                }
              />
              <SliderRow
                label={t("gfxI.thickness")}
                value={shape.heightPx}
                min={1}
                max={200}
                onPatch={(v, tr) =>
                  m(tr)((d) =>
                    updateClip(d, clipId, { shape: { ...clip.shape!, heightPx: Math.max(1, v) } }),
                  )
                }
              />
            </>
          ) : (
            <>
              <SliderRow
                label={t("gfxI.width")}
                value={shape.widthPx}
                min={1}
                max={canvas.width}
                onPatch={(v, tr) =>
                  m(tr)((d) =>
                    updateClip(d, clipId, { shape: { ...clip.shape!, widthPx: Math.max(1, v) } }),
                  )
                }
              />
              <SliderRow
                label={t("gfxI.height")}
                value={shape.heightPx}
                min={1}
                max={canvas.height}
                onPatch={(v, tr) =>
                  m(tr)((d) =>
                    updateClip(d, clipId, { shape: { ...clip.shape!, heightPx: Math.max(1, v) } }),
                  )
                }
              />
            </>
          )}
        </Section>
      )}

      {/* ANIMATION — in / loop / out tabs, all real renders */}
      <Section
        icon={Sparkles}
        title={t("gfxI.animation")}
        badge={clip.textFx ? clip.textFx.kind : undefined}
      >
        <div className="flex gap-1 rounded-lg bg-surface-1 p-1">
          {(
            [
              ["in", t("gfxI.animIn")],
              ["loop", t("gfxI.animLoop")],
              ["out", t("gfxI.animOut")],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors",
                animTab === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary",
              )}
              onClick={() => {
                setAnimTab(k);
                const first = ANIM_PRESETS.find((p) =>
                  k === "in"
                    ? p.category === "in"
                    : k === "out"
                      ? p.category === "out"
                      : p.category === "loop" || p.category === "emphasis" || p.category === "transition",
                );
                if (first) setPresetId(first.id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {visiblePresets.map((p) => (
            <button
              key={p.id}
              className={cn(
                "rounded-md border px-1.5 py-1.5 text-[10px] leading-tight transition-colors",
                presetId === p.id
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-muted-foreground/60 hover:bg-accent/40",
              )}
              onClick={() => setPresetId(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="w-14 shrink-0 text-muted-foreground">{t("gfxI.timing")}</span>
          <input
            className={cn(FIELD, "w-14")}
            type="number"
            value={dur}
            onChange={(e) => setDur(Math.max(0, Number(e.target.value)))}
            title={t("gfxI.durMs")}
          />
          <span className="text-muted-foreground">ms</span>
          <select
            className={cn(FIELD)}
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            title={t("gfxI.direction")}
          >
            {DIRS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            className={cn(FIELD)}
            value={easing}
            onChange={(e) => setEasing(e.target.value)}
            title={t("gfxI.easing")}
          >
            {EASINGS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input
            className={cn(FIELD, "w-14")}
            type="number"
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            title={t("gfxI.intensityPx")}
          />
        </div>
        {(presetId === "typewriter" || presetId === "typewriterOut" || presetId === "wipe" || presetId === "wipeOut" || presetId === "blurIn" || presetId === "blurOut") &&
          !supportsTextFx(doc, clipId) && (
            <p className="text-[9px] text-warning">{t("gfxI.textFxOnly")}</p>
          )}
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={applyAnim}
        >
          <Play className="size-3.5" /> {t("gfxI.applyAnim")}
        </button>
      </Section>

      {/* BRAND — kit bindings, unchanged behaviour */}
      {kit && (
        <Section icon={Brush} title={`${t("gfxI.brand")} · ${kit.name}`} defaultOpen={false}>
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{t("gfxI.color")}</span>
            <select
              className={cn(FIELD, "flex-1")}
              value={bind?.colorSlot ?? ""}
              onChange={(e) =>
                mutate((d) =>
                  bindClipBrand(d, clipId, {
                    colorSlot: e.target.value === "" ? null : Number(e.target.value),
                    fontSlot: bind?.fontSlot ?? null,
                  }),
                )
              }
            >
              <option value="">—</option>
              {kit.colors.map((c, i) => (
                <option key={i} value={i}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{t("gfxI.font")}</span>
            <select
              className={cn(FIELD, "flex-1")}
              value={bind?.fontSlot ?? ""}
              onChange={(e) =>
                mutate((d) =>
                  bindClipBrand(d, clipId, {
                    colorSlot: bind?.colorSlot ?? null,
                    fontSlot: e.target.value === "" ? null : Number(e.target.value),
                  }),
                )
              }
            >
              <option value="">—</option>
              {kit.fonts.map((f, i) => (
                <option key={i} value={i}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </Section>
      )}
    </div>
  );
}

/** Folded advanced typography controls — outline, box, shadow, spacing. */
function TypeExtras({
  style,
  patchStyle,
  swatches,
}: {
  style: NonNullable<Clip["textStyle"]>;
  patchStyle: (k: string, v: unknown, transient?: boolean) => void;
  swatches?: string[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        {t("gfxI.typeAdvanced")}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 border-l-2 border-border/60 pl-2">
          <ColorRow
            label={t("gfxI.outline")}
            value={style.outlineColor ?? "#000000"}
            onPatch={(v) => {
              patchStyle("outlineColor", v, false);
              if (style.outlineWidth < 1) patchStyle("outlineWidth", 1, false);
            }}
            swatches={swatches}
          />
          <SliderRow
            label={t("gfxI.outlineW")}
            value={style.outlineWidth}
            min={0}
            max={20}
            step={0.5}
            onPatch={(v, tr) => patchStyle("outlineWidth", Math.max(0, v), tr)}
          />
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{t("gfxI.box")}</span>
            <input
              type="checkbox"
              checked={!!style.backgroundColor}
              onChange={(e) =>
                patchStyle("backgroundColor", e.target.checked ? "#000000AA" : null)
              }
            />
            {style.backgroundColor && (
              <input
                type="color"
                className="h-5 w-10 rounded border border-border"
                value={style.backgroundColor.slice(0, 7)}
                onChange={(e) => patchStyle("backgroundColor", e.target.value + "AA")}
              />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{t("gfxI.shadow")}</span>
            <input
              type="checkbox"
              checked={!!style.shadowColor}
              onChange={(e) => patchStyle("shadowColor", e.target.checked ? "#000000CC" : null)}
            />
            {style.shadowColor && (
              <>
                <input
                  type="color"
                  className="h-5 w-10 rounded border border-border"
                  value={style.shadowColor.slice(0, 7)}
                  onChange={(e) => patchStyle("shadowColor", e.target.value + "CC")}
                />
                <input
                  type="number"
                  className={cn(FIELD, "w-11")}
                  value={style.shadowX ?? 0}
                  title={t("gfxI.shadowXPx")}
                  onChange={(e) => patchStyle("shadowX", Number(e.target.value))}
                />
                <input
                  type="number"
                  className={cn(FIELD, "w-11")}
                  value={style.shadowY ?? 0}
                  title={t("gfxI.shadowYPx")}
                  onChange={(e) => patchStyle("shadowY", Number(e.target.value))}
                />
              </>
            )}
          </div>
          <SliderRow
            label={t("gfxI.lineSpacing")}
            value={style.lineSpacingPx ?? 0}
            min={0}
            max={80}
            onPatch={(v, tr) => patchStyle("lineSpacingPx", v, tr)}
          />
        </div>
      )}
    </div>
  );
}

/** Graphics inspector section (ADR-027): visibility, align, shape fields,
    animation presets (real render), copy/paste style, brand bindings.
    Kept for NON-design clips (media overlays etc.); design clips get the
    full GraphicsInspector above. */
export function GraphicsSection({ clipId }: { clipId: string }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc)!;
  const mutate = useEditor((s) => s.mutate);
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const hit = findClip(doc, clipId);
  const [presetId, setPresetId] = useState("fadeIn");
  const [dur, setDur] = useState(400);
  const [intensity, setIntensity] = useState(160);
  const [dir, setDir] = useState("left");
  const [easing, setEasing] = useState("easeOut");
  const [animOut, setAnimOut] = useState(false);

  if (!hit) return null;
  const { clip, track } = hit;
  const isGraphic = track.kind === "text" || track.kind === "graphics" || clip.shape != null;
  const kit = doc.brandKit;
  const bind = clip.brandBindings;

  const applyAnim = () =>
    mutate((d) =>
      applyAnimationPreset(d, clipId, presetId, {
        durationMs: dur,
        intensity,
        direction: dir,
        easing,
        versionId: activeVersionId,
      }),
    );

  return (
    <section className="space-y-1.5 border-t border-border pt-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Graphics</span>
        {activeVersionId &&
          (() => {
            const v = doc.versions.find((x) => x.id === activeVersionId);
            const hasOv = !!v?.clipOverrides[clipId];
            return hasOv ? (
              <button
                className="rounded px-1 text-[9px] text-accent-foreground hover:bg-accent"
                title={t("gfxI.dropOverride")}
                onClick={() => mutate((d) => clearVersionClipOverrides(d, activeVersionId, clipId))}
              >
                re-sync
              </button>
            ) : null;
          })()}
        <span className="flex gap-0.5">
          <button
            className="rounded p-0.5 hover:bg-accent"
            title={t("gfxI.copyStyle")}
            onClick={() => (styleClipboard = clipStylePayload(clip))}
          >
            <Copy className="size-3" />
          </button>
          <button
            className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
            title={t("gfxI.pasteStyle")}
            disabled={!styleClipboard}
            onClick={() => styleClipboard && mutate((d) => applyClipStyle(d, clipId, styleClipboard!))}
          >
            <ClipboardPaste className="size-3" />
          </button>
          <button
            className="rounded p-0.5 hover:bg-accent"
            title={activeVersionId ? t("editor.hideInVersion") : t("editor.hideClip")}
            onClick={() =>
              mutate((d) => {
                if (activeVersionId) {
                  const v = d.versions.find((x) => x.id === activeVersionId);
                  if (!v) return d;
                  const nn = JSON.parse(JSON.stringify(d)) as typeof d;
                  const vv = nn.versions.find((x) => x.id === activeVersionId)!;
                  const ov = (vv.clipOverrides[clipId] ??= {});
                  ov.hidden = !(clip.hidden ?? false);
                  return nn;
                }
                return updateClip(d, clipId, { hidden: !(clip.hidden ?? false) });
              })
            }
          >
            {clip.hidden ? <EyeOff className="size-3 text-warning" /> : <Eye className="size-3" />}
          </button>
        </span>
      </div>

      {/* align */}
      <div className="flex gap-0.5">
        {(
          [
            ["left", AlignLeft],
            ["center", AlignCenter],
            ["right", AlignRight],
            ["top", AlignStartVertical],
            ["middle", AlignCenterVertical],
            ["bottom", AlignEndVertical],
          ] as const
        ).map(([a, Icon]) => (
          <button
            key={a}
            className="rounded border border-border p-1 hover:bg-accent"
            title={`Align ${a}`}
            onClick={() => mutate((d) => alignClipTo(d, clipId, a, 40))}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>

      {/* shape fields */}
      {clip.shape && (
        <div className="space-y-1 rounded border border-border p-1.5">
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="w-12 text-muted-foreground">fill</span>
            <input
              type="color"
              className="size-5 rounded"
              value={clip.shape.fill.slice(0, 7)}
              onChange={(e) =>
                mutate((d) => updateClip(d, clipId, { shape: { ...clip.shape!, fill: e.target.value } }))
              }
            />
            <span className="w-12 text-muted-foreground">size</span>
            <input
              className="w-14 rounded border border-border bg-background px-1"
              type="number"
              value={Math.round(clip.shape.widthPx)}
              onChange={(e) =>
                mutate((d) => updateClip(d, clipId, { shape: { ...clip.shape!, widthPx: Number(e.target.value) } }))
              }
            />
            <span>×</span>
            <input
              className="w-14 rounded border border-border bg-background px-1"
              type="number"
              value={Math.round(clip.shape.heightPx)}
              onChange={(e) =>
                mutate((d) => updateClip(d, clipId, { shape: { ...clip.shape!, heightPx: Number(e.target.value) } }))
              }
            />
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="w-12 text-muted-foreground">outline</span>
            <input
              type="color"
              className="size-5 rounded"
              value={(clip.shape.outlineColor ?? "#ffffff").slice(0, 7)}
              onChange={(e) =>
                mutate((d) =>
                  updateClip(d, clipId, { shape: { ...clip.shape!, outlineColor: e.target.value, outlineWidth: Math.max(1, clip.shape!.outlineWidth) } }),
                )
              }
            />
            <input
              className="w-14 rounded border border-border bg-background px-1"
              type="number"
              value={clip.shape.outlineWidth}
              onChange={(e) =>
                mutate((d) => updateClip(d, clipId, { shape: { ...clip.shape!, outlineWidth: Number(e.target.value) } }))
              }
            />
            <span className="text-muted-foreground">px</span>
          </div>
        </div>
      )}

      {/* animation presets — baked keyframes / textFx, real in render */}
      <div className="space-y-1 rounded border border-border p-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">animation</span>
          <label className="flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={animOut} onChange={(e) => setAnimOut(e.target.checked)} />
            out
          </label>
        </div>
        <div className="flex items-center gap-1">
          <select
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
          >
            {ANIM_PRESETS.filter((p) => (animOut ? p.category === "out" : p.category !== "out"))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </select>
          <button className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent" onClick={applyAnim}>
            Apply
          </button>
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <input className="w-12 rounded border border-border bg-background px-1" type="number" value={dur} onChange={(e) => setDur(Number(e.target.value))} title={t("gfxI.durMs")} />
          <span className="text-muted-foreground">ms</span>
          <select className="rounded border border-border bg-background px-1 py-0.5" value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="left">←</option>
            <option value="right">→</option>
            <option value="up">↑</option>
            <option value="down">↓</option>
          </select>
          <input className="w-12 rounded border border-border bg-background px-1" type="number" value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} title={t("gfxI.intensityPx")} />
          <select className="rounded border border-border bg-background px-1 py-0.5" value={easing} onChange={(e) => setEasing(e.target.value)}>
            <option value="linear">lin</option>
            <option value="easeOut">out</option>
            <option value="easeIn">in</option>
            <option value="easeInOut">io</option>
            <option value="backOut">back</option>
            <option value="bounceOut">bounce</option>
          </select>
        </div>
        {(presetId === "typewriter" || presetId === "wipe") && !supportsTextFx(doc, clipId) && (
          <div className="text-[9px] text-warning">Only on text/graphics clips</div>
        )}
      </div>

      {/* brand bindings */}
      {kit && (
        <div className="space-y-1 rounded border border-border p-1.5 text-[10px]">
          <span className="text-muted-foreground">brand · {kit.name}</span>
          <div className="flex items-center gap-1">
            <span className="w-10 text-muted-foreground">color</span>
            <select
              className="flex-1 rounded border border-border bg-background px-1 py-0.5"
              value={bind?.colorSlot ?? ""}
              onChange={(e) =>
                mutate((d) =>
                  bindClipBrand(d, clipId, {
                    colorSlot: e.target.value === "" ? null : Number(e.target.value),
                    fontSlot: bind?.fontSlot ?? null,
                  }),
                )
              }
            >
              <option value="">—</option>
              {kit.colors.map((c, i) => (
                <option key={i} value={i}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-10 text-muted-foreground">font</span>
            <select
              className="flex-1 rounded border border-border bg-background px-1 py-0.5"
              value={bind?.fontSlot ?? ""}
              onChange={(e) =>
                mutate((d) =>
                  bindClipBrand(d, clipId, {
                    colorSlot: bind?.colorSlot ?? null,
                    fontSlot: e.target.value === "" ? null : Number(e.target.value),
                  }),
                )
              }
            >
              <option value="">—</option>
              {kit.fonts.map((f, i) => (
                <option key={i} value={i}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {!isGraphic && <div className="text-[9px] text-muted-foreground">presets apply to any clip; typewriter/wipe need text/graphics</div>}
    </section>
  );
}

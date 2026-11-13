import { useState } from "react";
import { Copy, ClipboardPaste, Eye, EyeOff, AlignLeft, AlignCenter, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical } from "lucide-react";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  alignClipTo,
  applyAnimationPreset,
  applyClipStyle,
  bindClipBrand,
  clearVersionClipOverrides,
  clipStylePayload,
  findClip,
  updateClip,
} from "@/lib/timeline-engine";
import { ANIM_PRESETS, supportsTextFx } from "@/lib/anim-presets";

/** Shared style clipboard for copy/paste-style (session-scoped). */
let styleClipboard: ReturnType<typeof clipStylePayload> | null = null;

/** Graphics inspector section (ADR-027): visibility, align, shape fields,
    animation presets (real render), copy/paste style, brand bindings. */
export function GraphicsSection({ clipId }: { clipId: string }) {
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
                title="Drop this element's version overrides — re-sync to the shared base"
                onClick={() => mutate((d) => clearVersionClipOverrides(d, activeVersionId, clipId))}
              >
                re-sync
              </button>
            ) : null;
          })()}
        <span className="flex gap-0.5">
          <button
            className="rounded p-0.5 hover:bg-accent"
            title="Copy style"
            onClick={() => (styleClipboard = clipStylePayload(clip))}
          >
            <Copy className="size-3" />
          </button>
          <button
            className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
            title="Paste style"
            disabled={!styleClipboard}
            onClick={() => styleClipboard && mutate((d) => applyClipStyle(d, clipId, styleClipboard!))}
          >
            <ClipboardPaste className="size-3" />
          </button>
          <button
            className="rounded p-0.5 hover:bg-accent"
            title={activeVersionId ? "Hide in this version" : "Hide clip"}
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
          <input className="w-12 rounded border border-border bg-background px-1" type="number" value={dur} onChange={(e) => setDur(Number(e.target.value))} title="duration ms" />
          <span className="text-muted-foreground">ms</span>
          <select className="rounded border border-border bg-background px-1 py-0.5" value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="left">←</option>
            <option value="right">→</option>
            <option value="up">↑</option>
            <option value="down">↓</option>
          </select>
          <input className="w-12 rounded border border-border bg-background px-1" type="number" value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} title="intensity px" />
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

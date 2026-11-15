import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Diamond, Plus, Trash2 } from "lucide-react";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  addEffect,
  addTransition,
  effectiveDoc,
  findClip,
  getVersion,
  removeEffect,
  removeKeyframe,
  removeTransition,
  setKeyframe,
  setVersionClipOverride,
  transitionsFor,
  updateClip,
  updateEffect,
} from "@/lib/timeline-engine";
import { ANIMATABLE_PATHS, AUDIO_EFFECTS, EFFECTS, effectDef, type AnimatablePath } from "@/lib/effects";
import { AudioTools } from "@/modules/editor/AudioTools";
import { GraphicsInspector, GraphicsSection } from "@/modules/editor/GraphicsInspector";
import type { Clip } from "@/lib/project-types";

/**
 * Clip inspector — properties, keyframes, effect stack, transitions.
 * One-clip selection only; all edits flow through engine ops → undo history.
 */
export function Inspector() {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const playheadMs = useEditor((s) => s.playheadMs);
  const mutate = useEditor((s) => s.mutate);
  const activeVersionId = useEditor((s) => s.activeVersionId);

  if (!doc || selection.length !== 1) {
    return (
      <div className="h-full border-l border-border bg-card">
        <EmptyState
          compact
          icon={SlidersHorizontal}
          title={t("editor.nothingSelected")}
          body={t("editor.inspectorEmpty")}
        />
      </div>
    );
  }
  const clipId = selection[0];
  // Version-aware: when a format version is active, reframe fields
  // (transform + transform.* keyframes + textStyle) write to that
  // version's overrides — never into the shared base (ADR-021).
  const version = activeVersionId ? getVersion(doc, activeVersionId) : undefined;
  const viewDoc = effectiveDoc(doc, activeVersionId);
  const hit = findClip(viewDoc, clipId);
  if (!hit) return null;
  const { clip, track } = hit;
  const rel = playheadMs - clip.startMs;
  // The clip's effective transform in this version = override ?? base.
  const clipTransform = clip.transform;

  const patchTransform = (k: keyof Clip["transform"], v: number) => {
    if (version) {
      mutate((d) =>
        setVersionClipOverride(d, version.id, clipId, {
          transform: { ...clipTransform, [k]: v },
        }),
      );
    } else {
      mutate((d) => updateClip(d, clipId, { transform: { [k]: v } }));
    }
  };

  const keyAt = (path: AnimatablePath) => clip.keyframes[path]?.some((k) => k.tMs === Math.round(rel));

  const toggleKey = (path: AnimatablePath, current: number) => {
    if (version && path.startsWith("transform.")) {
      // Version-scoped keyframes: replace the path's list in overrides.
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

  const clipText = clip.text ?? "";
  const clipStyle = clip.textStyle;

  /** Text content — version override when active, else shared clip. */
  const patchText = (v: string) => {
    if (version) {
      mutate((d) => setVersionClipOverride(d, version.id, clipId, { text: v }));
    } else {
      mutate((d) => updateClip(d, clipId, { text: v }));
    }
  };

  const patchStyle = (k: string, v: unknown) => {
    const next = { ...(clipStyle ?? {}), [k]: v };
    if (version) {
      mutate((d) => setVersionClipOverride(d, version.id, clipId, { textStyle: next as never }));
    } else {
      mutate((d) => updateClip(d, clipId, { textStyle: next as Clip["textStyle"] }));
    }
  };

  const num = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    kfPath?: AnimatablePath,
    step = 1,
  ) => (
    <div className="flex items-center gap-1" key={label}>
      <span className="w-14 text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        className="w-full rounded border border-border bg-background px-1 py-0.5 text-xs"
        value={Number(value.toFixed(3))}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {kfPath && (
        <button
          className={`rounded p-0.5 ${keyAt(kfPath) ? "text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
          title={t("editor.keyframe")}
          onClick={() => toggleKey(kfPath, value)}
        >
          <Diamond className="size-3" />
        </button>
      )}
    </div>
  );

  const kfCount = (path: string) => clip.keyframes[path]?.length ?? 0;
  const clipTransitions = transitionsFor(doc, clipId);

  // Adjacent clips on the same track for transition creation.
  const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
  const idx = sorted.findIndex((c) => c.id === clipId);
  const nextClip = sorted[idx + 1];
  const hasOut = clipTransitions.some((tr) => tr.clipA === clipId);

  // Design elements (text/shape clips on text|graphics tracks, or any clip
  // carrying text/shape) get the design-studio inspector; media clips keep
  // the classic Transform/Audio/Graphics sections.
  const isDesign =
    clip.mediaRef == null &&
    (clip.text != null ||
      clip.textStyle != null ||
      clip.shape != null ||
      track.kind === "text" ||
      track.kind === "graphics");

  return (
    <div className="h-full space-y-4 overflow-y-auto border-l border-border bg-card p-3 text-xs">
      <div className="font-medium text-foreground">{t("editor.inspector")}</div>

      {isDesign ? (
        <GraphicsInspector clipId={clipId} />
      ) : (
        <>
          <section className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("editor.sectionTransform")}
            </div>
            {version && (
              <p className="text-[9px] italic text-accent-foreground/80">
                {t("versions.editingVersion", { name: version.name })}
              </p>
            )}
            {num("X", clipTransform.x, (v) => patchTransform("x", v), "transform.x")}
            {num("Y", clipTransform.y, (v) => patchTransform("y", v), "transform.y")}
            {num(t("editor.propScaleX"), clipTransform.scaleX, (v) => patchTransform("scaleX", v), "transform.scaleX", 0.05)}
            {num(t("editor.propScaleY"), clipTransform.scaleY, (v) => patchTransform("scaleY", v), "transform.scaleY", 0.05)}
            {num(t("editor.propRotate"), clipTransform.rotationDeg, (v) => patchTransform("rotationDeg", v), "transform.rotationDeg")}
            {num(t("editor.propOpacity"), clipTransform.opacity, (v) => patchTransform("opacity", Math.min(1, Math.max(0, v))), "transform.opacity", 0.05)}
          </section>

          <section className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("editor.sectionAudio")}
            </div>
            {num(t("editor.propVolume"), clip.volume, (v) => mutate((d) => updateClip(d, clipId, { volume: Math.max(0, Math.min(8, v)) })), "volume", 0.05)}
            {num(t("editor.propSpeed"), clip.speed, (v) => mutate((d) => updateClip(d, clipId, { speed: Math.max(0.1, Math.min(8, v)) })), undefined, 0.1)}
            {num(t("editor.propPan"), clip.pan ?? 0, (v) => mutate((d) => updateClip(d, clipId, { pan: Math.max(-1, Math.min(1, v)) })), undefined, 0.05)}
            {num(t("editor.propFadeIn"), clip.fadeInMs ?? 0, (v) => mutate((d) => updateClip(d, clipId, { fadeInMs: Math.max(0, v) })), undefined, 50)}
            {num(t("editor.propFadeOut"), clip.fadeOutMs ?? 0, (v) => mutate((d) => updateClip(d, clipId, { fadeOutMs: Math.max(0, v) })), undefined, 50)}
            <AudioTools clipId={clipId} trackId={track.id} />
          </section>

          <GraphicsSection clipId={clipId} />
        </>
      )}

      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("editor.sectionEffects")}
          </span>
          <select
            className="rounded border border-border bg-background px-1 py-0.5 text-[10px]"
            value=""
            onChange={(e) => {
              const def = effectDef(e.target.value);
              if (!def) return;
              mutate((d) =>
                addEffect(d, clipId, {
                  id: crypto.randomUUID(),
                  type: def.type,
                  enabled: true,
                  params: Object.fromEntries(
                    Object.entries(def.params).map(([k, s]) => [k, s.def]),
                  ),
                }),
              );
            }}
          >
            <option value="">{t("editor.addEffect")}</option>
            {EFFECTS.map((d) => (
              <option key={d.type} value={d.type}>
                {d.label}
              </option>
            ))}
            {AUDIO_EFFECTS.map((d) => (
              <option key={d.type} value={d.type}>
                [audio] {d.label}
              </option>
            ))}
          </select>
        </div>
        {clip.effects.map((fx) => {
          const def = effectDef(fx.type);
          return (
            <div key={fx.id} className="space-y-1 rounded border border-border p-1.5">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={fx.enabled}
                    onChange={(e) =>
                      mutate((d) => updateEffect(d, clipId, fx.id, { enabled: e.target.checked }))
                    }
                  />
                  <span>{def?.label ?? fx.type}</span>
                </label>
                <button
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => mutate((d) => removeEffect(d, clipId, fx.id))}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
              {def &&
                Object.entries(def.params).map(([pk, spec]) => (
                  <div key={pk} className="flex items-center gap-1.5">
                    <span className="w-14 text-[10px] text-muted-foreground">{pk}</span>
                    <input
                      type="range"
                      className="flex-1"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={fx.params[pk] ?? spec.def}
                      onChange={(e) =>
                        mutate((d) =>
                          updateEffect(d, clipId, fx.id, {
                            params: { [pk]: Number(e.target.value) },
                          }),
                        )
                      }
                    />
                    <span className="w-10 text-right font-mono text-[10px]">
                      {(fx.params[pk] ?? spec.def).toFixed(2)}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
        {clip.effects.length === 0 && (
          <p className="text-[10px] text-muted-foreground">{t("editor.noEffects")}</p>
        )}
      </section>

      <section className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("editor.sectionKeyframes")}
        </div>
        {ANIMATABLE_PATHS.filter((pth) => kfCount(pth) > 0).map((pth) => (
          <div key={pth} className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{pth}</span>
            <span className="flex items-center gap-1 text-accent-foreground">
              <Diamond className="size-2.5" /> {kfCount(pth)}
            </span>
          </div>
        ))}
        {ANIMATABLE_PATHS.every((pth) => kfCount(pth) === 0) && (
          <p className="text-[10px] text-muted-foreground">{t("editor.noKeyframes")}</p>
        )}
      </section>

      {!isDesign && (clipText !== "" || clip.text != null) ? (
        <section className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("editor.sectionText")}
            {version && <span className="ml-1 text-accent-foreground/80">({t("versions.editingVersionShort")})</span>}
          </div>
          <textarea
            className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs"
            rows={2}
            value={clipText}
            onChange={(e) => patchText(e.target.value)}
          />
          {clipStyle && (
            <div className="space-y-1">
              {num(t("editor.propFontPx"), clipStyle.fontSizePx, (v) => patchStyle("fontSizePx", Math.max(1, v)))}
              <div className="flex items-center gap-1">
                <span className="w-14 text-[10px] text-muted-foreground">Color</span>
                <input type="color" className="h-5 w-10" value={clipStyle.color.slice(0, 7)}
                  onChange={(e) => patchStyle("color", e.target.value)} />
              </div>
              <div className="flex items-center gap-1">
                <span className="w-14 text-[10px] text-muted-foreground">Align</span>
                <select className="flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
                  value={clipStyle.alignH} onChange={(e) => patchStyle("alignH", e.target.value)}>
                  <option value="left">←</option><option value="center">↔</option><option value="right">→</option>
                </select>
                <select className="flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
                  value={clipStyle.alignV} onChange={(e) => patchStyle("alignV", e.target.value)}>
                  <option value="top">↑</option><option value="middle">↕</option><option value="bottom">↓</option>
                </select>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-14 text-[10px] text-muted-foreground">Outline</span>
                <input type="color" className="h-5 w-10"
                  value={(clipStyle.outlineColor ?? "#000000").slice(0, 7)}
                  onChange={(e) => patchStyle("outlineColor", e.target.value)} />
                <input type="number" className="w-14 rounded border border-border bg-background px-1 py-0.5 text-xs"
                  min={0} step={0.5} value={clipStyle.outlineWidth}
                  onChange={(e) => patchStyle("outlineWidth", Math.max(0, Number(e.target.value)))} />
              </div>
              <div className="flex items-center gap-1">
                <span className="w-14 text-[10px] text-muted-foreground">Box</span>
                <input type="checkbox" checked={!!clipStyle.backgroundColor}
                  onChange={(e) => patchStyle("backgroundColor", e.target.checked ? "#000000AA" : null)} />
                {clipStyle.backgroundColor && (
                  <input type="color" className="h-5 w-10"
                    value={clipStyle.backgroundColor.slice(0, 7)}
                    onChange={(e) => patchStyle("backgroundColor", e.target.value + "AA")} />
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="w-14 text-[10px] text-muted-foreground">Shadow</span>
                <input type="checkbox" checked={!!clipStyle.shadowColor}
                  onChange={(e) => patchStyle("shadowColor", e.target.checked ? "#000000CC" : null)} />
                {clipStyle.shadowColor && (
                  <>
                    <input type="color" className="h-5 w-10"
                      value={clipStyle.shadowColor.slice(0, 7)}
                      onChange={(e) => patchStyle("shadowColor", e.target.value + "CC")} />
                    <input type="number" className="w-11 rounded border border-border bg-background px-1 py-0.5 text-xs"
                      value={clipStyle.shadowX ?? 0} title={t("gfxI.shadowXPx")}
                      onChange={(e) => patchStyle("shadowX", Number(e.target.value))} />
                    <input type="number" className="w-11 rounded border border-border bg-background px-1 py-0.5 text-xs"
                      value={clipStyle.shadowY ?? 0} title={t("gfxI.shadowYPx")}
                      onChange={(e) => patchStyle("shadowY", Number(e.target.value))} />
                  </>
                )}
              </div>
              {num(t("gfxI.lineSpacing"), clipStyle.lineSpacingPx ?? 0, (v) => patchStyle("lineSpacingPx", v))}
            </div>
          )}
        </section>
      ) : null}

      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("editor.sectionTransitions")}
          </span>
          {nextClip && !hasOut && (
            <button
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent"
              onClick={() =>
                mutate((d) => addTransition(d, track.id, clipId, nextClip.id, 500)?.doc ?? d)
              }
            >
              <Plus className="size-3" /> {t("editor.addTransition")}
            </button>
          )}
        </div>
        {clipTransitions.map((tr) => (
          <div key={tr.id} className="flex items-center justify-between rounded border border-border p-1.5">
            <span>
              {tr.type} · {(tr.durationMs / 1000).toFixed(2)}s
            </span>
            <button
              className="text-muted-foreground hover:text-destructive"
              onClick={() => mutate((d) => removeTransition(d, track.id, tr.id))}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
        {clipTransitions.length === 0 && (
          <p className="text-[10px] text-muted-foreground">{t("editor.noTransitions")}</p>
        )}
      </section>
    </div>
  );
}

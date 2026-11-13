import { useTranslation } from "react-i18next";
import { Diamond, Plus, Trash2 } from "lucide-react";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  addEffect,
  addTransition,
  findClip,
  removeEffect,
  removeKeyframe,
  removeTransition,
  setKeyframe,
  transitionsFor,
  updateClip,
  updateEffect,
} from "@/lib/timeline-engine";
import { ANIMATABLE_PATHS, EFFECTS, effectDef, type AnimatablePath } from "@/lib/effects";
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

  if (!doc || selection.length !== 1) {
    return (
      <div className="flex h-full items-start justify-center border-l border-border bg-card p-4 text-xs text-muted-foreground">
        {t("editor.inspectorEmpty")}
      </div>
    );
  }
  const clipId = selection[0];
  const hit = findClip(doc, clipId);
  if (!hit) return null;
  const { clip, track } = hit;
  const rel = playheadMs - clip.startMs;

  const patchTransform = (k: keyof Clip["transform"], v: number) =>
    mutate((d) => updateClip(d, clipId, { transform: { [k]: v } }));

  const keyAt = (path: AnimatablePath) => clip.keyframes[path]?.some((k) => k.tMs === Math.round(rel));

  const toggleKey = (path: AnimatablePath, current: number) => {
    mutate((d) =>
      keyAt(path)
        ? removeKeyframe(d, clipId, path, rel)
        : setKeyframe(d, clipId, path, rel, current),
    );
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
          className={`rounded p-0.5 ${keyAt(kfPath) ? "text-cyan-400" : "text-muted-foreground hover:text-foreground"}`}
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

  return (
    <div className="h-full space-y-4 overflow-y-auto border-l border-border bg-card p-3 text-xs">
      <div className="font-medium text-foreground">{t("editor.inspector")}</div>

      <section className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("editor.sectionTransform")}
        </div>
        {num("X", clip.transform.x, (v) => patchTransform("x", v), "transform.x")}
        {num("Y", clip.transform.y, (v) => patchTransform("y", v), "transform.y")}
        {num("Scale X", clip.transform.scaleX, (v) => patchTransform("scaleX", v), "transform.scaleX", 0.05)}
        {num("Scale Y", clip.transform.scaleY, (v) => patchTransform("scaleY", v), "transform.scaleY", 0.05)}
        {num("Rotate°", clip.transform.rotationDeg, (v) => patchTransform("rotationDeg", v), "transform.rotationDeg")}
        {num("Opacity", clip.transform.opacity, (v) => patchTransform("opacity", Math.min(1, Math.max(0, v))), "transform.opacity", 0.05)}
      </section>

      <section className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("editor.sectionAudio")}
        </div>
        {num("Volume", clip.volume, (v) => mutate((d) => updateClip(d, clipId, { volume: Math.max(0, Math.min(8, v)) })), "volume", 0.05)}
        {num("Speed", clip.speed, (v) => mutate((d) => updateClip(d, clipId, { speed: Math.max(0.1, Math.min(8, v)) })), undefined, 0.1)}
      </section>

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
            <span className="flex items-center gap-1 text-cyan-400">
              <Diamond className="size-2.5" /> {kfCount(pth)}
            </span>
          </div>
        ))}
        {ANIMATABLE_PATHS.every((pth) => kfCount(pth) === 0) && (
          <p className="text-[10px] text-muted-foreground">{t("editor.noKeyframes")}</p>
        )}
      </section>

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

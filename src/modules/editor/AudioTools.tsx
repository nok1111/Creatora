import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Ear, Guitar, Mic2, Plus, Scissors, Trash2, Volume2, Wand2 } from "lucide-react";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  addEffect,
  applySilenceCut,
  findClip,
  removeDuckingRule,
  updateClip,
  upsertDuckingRule,
} from "@/lib/timeline-engine";
import { api, type Loudness } from "@/lib/ipc";

/**
 * Clip-level audio tools (ADR-026): loudness measure + non-destructive
 * normalize suggestion, silence-detection proposal (never destructive —
 * the user reviews then applies), and the doc-level auto-duck rules that
 * involve this clip's track.
 */
/** Friendly one-click presets — additive only (addEffect appends; a type
 * already enabled is skipped), so custom chains are never overwritten. */
const PRESETS: { key: string; labelKey: string; icon: React.ReactNode; effects: { type: string; params: Record<string, number> }[] }[] = [
  { key: "voice", labelKey: "audio.presetVoice", icon: <Mic2 className="size-3.5" />,
    effects: [{ type: "compressor", params: { thresholdDb: -20, ratio: 3 } }, { type: "eq", params: { mid: 3 } }] },
  { key: "noise", labelKey: "audio.presetNoise", icon: <Ear className="size-3.5" />,
    effects: [{ type: "denoise", params: { strength: 14 } }, { type: "noisegate", params: { thresholdDb: -45 } }] },
  { key: "enhance", labelKey: "audio.presetEnhance", icon: <Wand2 className="size-3.5" />,
    effects: [{ type: "deesser", params: { amount: 0.5 } }, { type: "eq", params: { low: 2, high: 2 } }] },
  { key: "louder", labelKey: "audio.presetLouder", icon: <Guitar className="size-3.5" />,
    effects: [{ type: "limiter", params: { levelDb: -1 } }] },
];

export function AudioTools({ clipId, trackId }: { clipId: string; trackId: string }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc)!;
  const mutate = useEditor((s) => s.mutate);
  const clip = findClip(doc, clipId)?.clip;
  const [silence, setSilence] = useState<{ startMs: number; endMs: number }[] | null>(null);
  const [noiseDb, setNoiseDb] = useState(-35);
  const [minMs, setMinMs] = useState(500);
  const [padMs, setPadMs] = useState(120);
  const [loud, setLoud] = useState<Loudness | null>(null);
  const [target, setTarget] = useState(-14);
  const [busy, setBusy] = useState(false);

  const srcPath = clip
    ? doc.mediaRefs.find((m) => m.assetId === clip.mediaRef)?.path
    : undefined;
  if (!clip || !srcPath) return null;
  const audioTracks = doc.timeline.tracks.filter((tk) => tk.kind !== "text");
  const rules = doc.ducking.filter((r) => r.sourceTrack === trackId || r.targetTrack === trackId);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const enabledTypes = new Set((clip.effects ?? []).filter((e) => e.enabled).map((e) => e.type));

  const sectionLabel = (children: React.ReactNode) => (
    <p className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );

  return (
    <div className="space-y-1.5 border-t border-border pt-1.5">
      {/* friendly one-click presets — additive, skip already-enabled types */}
      {sectionLabel(t("audio.enhance"))}
      <div className="mb-2 flex flex-wrap gap-1">
        {PRESETS.map((p) => {
          const applied = p.effects.every((e) => enabledTypes.has(e.type));
          const label = t(p.labelKey);
          return (
          <button
            key={p.key}
            title={t("audio.presetAdds", { label, effects: p.effects.map((e) => e.type).join(" + ") })}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors ${
              applied
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                : "border-border bg-card hover:border-accent hover:bg-accent/10"
            }`}
            onClick={() =>
              mutate((d) => {
                let dd = d;
                const existing = new Set((clip?.effects ?? []).filter((e) => e.enabled).map((e) => e.type));
                for (const e of p.effects) {
                  if (existing.has(e.type)) continue;
                  dd = addEffect(dd, clipId, {
                    id: crypto.randomUUID(),
                    type: e.type,
                    enabled: true,
                    params: e.params,
                  });
                }
                return dd;
              })
            }
          >
            {applied ? <CheckCircle2 className="size-3.5" /> : p.icon} {label}
          </button>
          );
        })}
        {/* Balance Music — contextual: only when a second audio track
            exists to act as the voice target. */}
        {(() => {
          const otherAudio = doc.timeline.tracks.filter((t) => t.id !== trackId && (t.kind === "audio" || t.clips.some((c) => !c.hidden)));
          const hasRule = doc.ducking.some((r) => r.sourceTrack === trackId);
          if (otherAudio.length === 0) {
            return (
              <span
                className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground"
                title={t("audio.balanceNeedsTitle")}
              >
                <Guitar className="size-3.5" /> {t("audio.balanceNeedsVoice")}
              </span>
            );
          }
          return (
            <select
              className="rounded-md border border-border bg-card px-1.5 py-1 text-[10px]"
              value=""
              title={t("audio.balanceTitle")}
              onChange={(e) => {
                if (!e.target.value) return;
                mutate((d) =>
                  upsertDuckingRule(d, {
                    id: doc.ducking.find((r) => r.sourceTrack === trackId)?.id ?? crypto.randomUUID(),
                    sourceTrack: trackId,
                    targetTrack: e.target.value,
                    thresholdDb: -30,
                    reductionDb: -12,
                    attackMs: 80,
                    releaseMs: 400,
                    holdMs: 150,
                  }),
                );
              }}
            >
              <option value="">{hasRule ? t("audio.balanceActive") : t("audio.balancePick")}</option>
              {otherAudio.map((t2) => (
                <option key={t2.id} value={t2.id}>{t("audio.trackSuffix", { name: t2.name ?? t2.kind })}</option>
              ))}
            </select>
          );
        })()}
      </div>

      {/* loudness: measure + non-destructive gain suggestion */}
      {sectionLabel(t("audio.loudness"))}
      <div className="flex items-center gap-1">
        <select
          className="rounded border border-border bg-background px-1 py-0.5 text-[10px]"
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          title={t("audio.lufsTitle")}
        >
          <option value={-14}>{t("audio.lufsYoutube")}</option>
          <option value={-16}>{t("audio.lufsPodcast")}</option>
          <option value={-11}>{t("audio.lufsSocial")}</option>
          <option value={-23}>{t("audio.lufsEbu")}</option>
        </select>
        <button
          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
          disabled={busy}
          onClick={() => withBusy(async () => setLoud(await api.analyzeLoudness(srcPath)))}
        >
          <Volume2 className="mr-0.5 inline size-3" /> {t("audio.measure")}
        </button>
        <button
          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            withBusy(async () => {
              const sg = await api.suggestNormalize(srcPath, target, -1.0);
              setLoud({
                integrated: sg.measuredLufs,
                truePeak: sg.truePeakDb,
                lra: sg.lraLu,
                threshold: 0,
              });
              const gainLin = Math.pow(10, sg.gainDb / 20);
              mutate((d) => {
                let dd = updateClip(d, clipId, {
                  volume: Math.max(0, Math.min(8, (clip.volume ?? 1) * gainLin)),
                });
                if (sg.needsLimiter)
                  dd = addEffect(dd, clipId, {
                    id: crypto.randomUUID(),
                    type: "limiter",
                    enabled: true,
                    params: { levelDb: -1 },
                  });
                return dd;
              });
            })
          }
        >
          {t("audio.normalize")}
        </button>
      </div>
      {loud && (
        <div className="rounded bg-muted/50 px-1.5 py-1 font-mono text-[10px] text-muted-foreground">
          {loud.integrated.toFixed(1)} LUFS · TP {loud.truePeak.toFixed(1)} dB · LRA{" "}
          {loud.lra.toFixed(1)}
        </div>
      )}

      {/* silence detection → reviewable proposal, never destructive */}
      {sectionLabel(t("audio.silenceSection"))}
      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-muted-foreground">{t("audio.silenceLbl")}</span>
        <input
          className="w-10 rounded border border-border bg-background px-1"
          type="number"
          value={noiseDb}
          onChange={(e) => setNoiseDb(Number(e.target.value))}
        />
        <span className="text-muted-foreground">dB ≥</span>
        <input
          className="w-12 rounded border border-border bg-background px-1"
          type="number"
          value={minMs}
          onChange={(e) => setMinMs(Number(e.target.value))}
        />
        <span className="text-muted-foreground">{t("audio.silenceMsPad")}</span>
        <input
          className="w-12 rounded border border-border bg-background px-1"
          type="number"
          value={padMs}
          onChange={(e) => setPadMs(Number(e.target.value))}
        />
        <button
          className="rounded border border-border px-1.5 py-0.5 hover:bg-accent disabled:opacity-50"
          disabled={busy}
          onClick={() => withBusy(async () => setSilence(await api.detectSilence(srcPath, noiseDb, minMs)))}
        >
          {t("audio.detect")}
        </button>
      </div>
      {silence && (
        <div className="space-y-1 rounded border border-amber-500/40 bg-warning/15 p-1.5 text-[10px]">
          <div className="text-muted-foreground">
            {t("audio.silenceRegions", { count: silence.length })}
          </div>
          <div className="max-h-16 overflow-y-auto font-mono">
            {silence.map((r, i) => (
              <div key={i}>
                {(r.startMs / 1000).toFixed(2)}s → {(r.endMs / 1000).toFixed(2)}s
              </div>
            ))}
          </div>
          <button
            className="rounded border border-amber-500/60 px-1.5 py-0.5 hover:bg-amber-500/20"
            disabled={silence.length === 0}
            onClick={() => mutate((d) => applySilenceCut(d, clipId, silence, padMs) ?? d)}
          >
            <Scissors className="mr-0.5 inline size-3" /> {t("audio.applyCut")}
          </button>
        </div>
      )}

      {/* auto-duck rules involving this track */}
      {sectionLabel(t("audio.duckSection"))}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">{t("audio.duckAuto")}</span>
          <button
            className="rounded border border-border px-1 py-0.5 hover:bg-accent"
            onClick={() => {
              const other = audioTracks.find((tk) => tk.id !== trackId);
              if (!other) return;
              mutate((d) =>
                upsertDuckingRule(d, {
                  id: crypto.randomUUID(),
                  sourceTrack: trackId,
                  targetTrack: other.id,
                  thresholdDb: -35,
                  reductionDb: -12,
                  attackMs: 80,
                  releaseMs: 500,
                  holdMs: 300,
                }),
              );
            }}
          >
            <Plus className="inline size-3" /> {t("audio.duckRule")}
          </button>
        </div>
        {rules.map((r) => (
          <div key={r.id} className="space-y-0.5 rounded border border-border p-1 text-[10px]">
            <div className="flex items-center justify-between">
              <select
                className="rounded border border-border bg-background px-0.5"
                value={r.sourceTrack}
                onChange={(e) =>
                  mutate((d) => upsertDuckingRule(d, { ...r, sourceTrack: e.target.value }))
                }
              >
                {audioTracks.map((tk) => (
                  <option key={tk.id} value={tk.id}>
                    {t("audio.duckSrc")}: {tk.name}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">→</span>
              <select
                className="rounded border border-border bg-background px-0.5"
                value={r.targetTrack}
                onChange={(e) =>
                  mutate((d) => upsertDuckingRule(d, { ...r, targetTrack: e.target.value }))
                }
              >
                {audioTracks.map((tk) => (
                  <option key={tk.id} value={tk.id}>
                    {t("audio.duckDst")}: {tk.name}
                  </option>
                ))}
              </select>
              <button
                className="text-muted-foreground hover:text-destructive"
                onClick={() => mutate((d) => removeDuckingRule(d, r.id))}
              >
                <Trash2 className="size-3" />
              </button>
            </div>
            {(
              [
                ["audio.duckThresh", "thresholdDb", -60, 0, 1],
                ["audio.duckReduce", "reductionDb", -40, 0, 1],
                ["audio.duckAttack", "attackMs", 1, 1000, 5],
                ["audio.duckRelease", "releaseMs", 10, 3000, 10],
                ["audio.duckHold", "holdMs", 0, 2000, 10],
              ] as const
            ).map(([lbl, k, mn, mx, st]) => (
              <div key={k} className="flex items-center gap-1">
                <span className="w-10 text-muted-foreground">{t(lbl)}</span>
                <input
                  type="range"
                  className="flex-1"
                  min={mn}
                  max={mx}
                  step={st}
                  value={r[k]}
                  onChange={(e) =>
                    mutate((d) => upsertDuckingRule(d, { ...r, [k]: Number(e.target.value) }))
                  }
                />
                <span className="w-8 text-right font-mono">{r[k]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

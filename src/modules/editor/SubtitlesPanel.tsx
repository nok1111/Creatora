import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Captions,
  ChevronRight,
  Clock,
  Download,
  ListChecks,
  Merge,
  Mic2,
  Plus,
  Scissors,
  Trash2,
  Wand2,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/ipc";
import { awaitJob, onJobProgress } from "@/services/jobs";
import { requestProjectSwitch } from "@/services/project-switch";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  activeCueAt,
  addCue,
  diagnoseCues,
  duplicateCue,
  findReplaceCues,
  fixOverlaps,
  mergeCueWithNext,
  removeCue,
  scaleCueTimes,
  setVersionSubtitleStyle,
  shiftAllCues,
  splitCue,
  updateCue,
} from "@/lib/timeline-engine";
import { SUBTITLE_PRESETS } from "@/lib/subtitle-presets";
import type { AssetSummary } from "@/lib/media-types";
import type { SubtitleCue } from "@/lib/project-types";
import { Button } from "@/components/ui/button";

const fmtMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 10)).padStart(2, "0")}`;
};
const parseTc = (v: string): number | null => {
  const m = v.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return (parseInt(m[1]) * 60 + parseFloat(m[2])) * 1000;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n * 1000 : null;
};

/**
 * Subtitle Studio (ADR-025): transcribe → edit cues → style → export.
 * Cues are shared; versions override STYLE only. All mutations are
 * undo-safe via useEditor.mutate.
 */
export function SubtitlesPanel({ assets }: { assets: Map<string, AssetSummary> }) {
  const doc = useProject((s) => s.doc);
  const filePath = useProject((s) => s.filePath);
  const playheadMs = useEditor((s) => s.playheadMs);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const mutate = useEditor((s) => s.mutate);
  const versionId = useEditor((s) => s.activeVersionId);

  const [selected, setSelected] = useState<string | null>(null);
  const [model, setModel] = useState("ggml-tiny.bin");
  const [lang, setLang] = useState("auto");
  const [sourceId, setSourceId] = useState("");
  const [job, setJob] = useState<{ id: string; p: number } | null>(null);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [shift, setShift] = useState("0");
  const [issues, setIssues] = useState<ReturnType<typeof diagnoseCues> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const modelsQ = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const mediaAssets = useMemo(
    () => [...assets.values()].filter((a) => a.kind !== "image"),
    [assets],
  );

  const cues = useMemo(
    () => [...(doc?.subtitles ?? [])].sort((a, b) => a.startMs - b.startMs),
    [doc?.subtitles],
  );
  const activeCue = doc ? activeCueAt(doc, playheadMs) : null;
  const style = useMemo(() => {
    if (!doc) return null;
    const v = doc.versions.find((x) => x.id === versionId);
    return v?.subtitleStyle ?? doc.subtitleStyle;
  }, [doc, versionId]);

  // Follow the playhead — scroll the active cue into view.
  useEffect(() => {
    if (!activeCue || !listRef.current) return;
    listRef.current
      .querySelector(`[data-cue="${activeCue.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeCue?.id]);

  if (!doc) return null;

  const setStyle = (patch: Parameters<typeof setVersionSubtitleStyle>[2] | Partial<NonNullable<typeof style>>) => {
    if (!style) return;
    const next = { ...style, ...patch } as NonNullable<typeof style>;
    mutate((d) =>
      versionId ? setVersionSubtitleStyle(d, versionId, next) : { ...d, subtitleStyle: next },
    );
  };

  const transcribe = async () => {
    const src = sourceId ? assets.get(sourceId)?.filePath : mediaAssets[0]?.filePath;
    if (!src || !filePath) return toast.error("import an audio/video asset first");
    // Transcription writes cues into the saved project — save first.
    await useProject.getState().save();
    const id = await api.transcribeMedia(filePath, src, model, lang).catch((e) => {
      toast.error(String(e));
      return null;
    });
    if (!id) return;
    setJob({ id, p: 0 });
    const off = onJobProgress((e) => {
      if (e.jobId === id) setJob({ id, p: e.progress });
    });
    try {
      const res = await awaitJob(id);
      await new Promise<void>((resolve) => {
        requestProjectSwitch(async () => {
          await useProject.getState().openFromPath(filePath);
          resolve();
        });
      });
      const r = res as { cues?: number; withWords?: number };
      toast.success(`${r.cues ?? 0} cues (${r.withWords ?? 0} with word timing)`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      off();
      setJob(null);
    }
  };

  const exportAs = async (format: "srt" | "vtt" | "ass") => {
    const out = await saveDialog({ defaultPath: `subtitles.${format}` });
    if (!out || !filePath) return;
    await api.exportSubtitles(filePath, out, format, versionId ?? undefined)
      .then(() => toast.success(`${format.toUpperCase()} exported`))
      .catch((e) => toast.error(String(e)));
  };

  const cueRow = (cue: SubtitleCue) => {
    const isActive = activeCue?.id === cue.id;
    return (
      <div
        key={cue.id}
        data-cue={cue.id}
        className={`group rounded border px-2 py-1 text-xs ${
          selected === cue.id
            ? "border-cyan-500/60 bg-accent"
            : isActive
              ? "border-emerald-500/50 bg-emerald-500/5"
              : "border-border/60 hover:border-border"
        }`}
        onClick={() => {
          setSelected(cue.id);
          setPlayhead(cue.startMs);
        }}
      >
        <div className="flex items-center gap-1.5">
          <input
            className="w-16 rounded bg-transparent font-mono text-[10px] text-muted-foreground outline-none"
            defaultValue={fmtMs(cue.startMs)}
            key={`s${cue.startMs}`}
            onBlur={(e) => {
              const t = parseTc(e.target.value);
              if (t != null && t !== cue.startMs)
                mutate((d) => updateCue(d, cue.id, { startMs: t }));
            }}
          />
          <ChevronRight className="size-3 text-muted-foreground" />
          <input
            className="w-16 rounded bg-transparent font-mono text-[10px] text-muted-foreground outline-none"
            defaultValue={fmtMs(cue.endMs)}
            key={`e${cue.endMs}`}
            onBlur={(e) => {
              const t = parseTc(e.target.value);
              if (t != null && t !== cue.endMs)
                mutate((d) => updateCue(d, cue.id, { endMs: t }));
            }}
          />
          <span className="ml-auto flex opacity-0 transition group-hover:opacity-100">
            <button title="Split at playhead" className="p-0.5 hover:text-accent-foreground"
              onClick={(e) => { e.stopPropagation(); mutate((d) => splitCue(d, cue.id, playheadMs)?.doc ?? d); }}>
              <Scissors className="size-3" />
            </button>
            <button title="Merge with next" className="p-0.5 hover:text-accent-foreground"
              onClick={(e) => { e.stopPropagation(); mutate((d) => mergeCueWithNext(d, cue.id)?.doc ?? d); }}>
              <Merge className="size-3" />
            </button>
            <button title="Duplicate" className="p-0.5 hover:text-accent-foreground"
              onClick={(e) => { e.stopPropagation(); mutate((d) => duplicateCue(d, cue.id)?.doc ?? d); }}>
              <Plus className="size-3" />
            </button>
            <button title="Delete" className="p-0.5 hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); mutate((d) => removeCue(d, cue.id)); }}>
              <Trash2 className="size-3" />
            </button>
          </span>
        </div>
        <input
          className="mt-0.5 w-full rounded bg-transparent px-0.5 outline-none focus:bg-accent/40"
          value={cue.text}
          onChange={(e) => mutate((d) => updateCue(d, cue.id, { text: e.target.value }))}
        />
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 border-t border-border bg-card/30">
      {/* Cue list */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {cues.length} cues
          </span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[10px]"
            onClick={() => mutate((d) => addCue(d, { startMs: playheadMs, endMs: playheadMs + 2000, text: "New cue", words: [] }).doc)}>
            <Plus className="mr-1 size-3" />Add
          </Button>
          <input placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)}
            className="h-6 w-24 rounded border border-border bg-transparent px-1.5 text-[10px]" />
          <input placeholder="Replace" value={replace} onChange={(e) => setReplace(e.target.value)}
            className="h-6 w-24 rounded border border-border bg-transparent px-1.5 text-[10px]" />
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]"
            onClick={() => {
              const r = findReplaceCues(doc, find, replace);
              if (r.count) { mutate(() => r.doc); toast.success(`${r.count} replaced`); }
            }}>
            Apply
          </Button>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
          {cues.length === 0 && (
            <EmptyState
              compact
              icon={Captions}
              title="No captions yet"
              body="Transcribe an audio or video asset locally, or add a cue manually at the playhead."
              action={{
                label: "Add cue",
                onClick: () =>
                  mutate((d) => addCue(d, { startMs: playheadMs, endMs: playheadMs + 2000, text: "New cue", words: [] }).doc),
              }}
            />
          )}
          {cues.map(cueRow)}
        </div>
      </div>

      {/* Tools */}
      <div className="w-72 shrink-0 space-y-2 overflow-y-auto border-l border-border p-2 text-xs">
        {/* Transcription */}
        <div className="rounded border border-border/60 p-2">
          <p className="mb-1.5 flex items-center gap-1 font-medium"><Mic2 className="size-3" /> Transcribe</p>
          <div className="grid grid-cols-2 gap-1">
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="h-6 rounded border border-border bg-transparent px-1 text-[10px]">
              {modelsQ.data?.map((m) => (
                <option key={m.name} value={m.name} disabled={!m.present}
                  className="bg-card">
                  {m.name.replace("ggml-", "").replace(".bin", "")} · {m.tier}
                  {m.present ? "" : " (not downloaded)"}
                </option>
              ))}
            </select>
            <select value={lang} onChange={(e) => setLang(e.target.value)}
              className="h-6 rounded border border-border bg-transparent px-1 text-[10px]">
              {["auto","en","es","fr","de","pt","it","ja","zh"].map((l) => (
                <option key={l} value={l} className="bg-card">{l === "auto" ? "Auto-detect" : l}</option>
              ))}
            </select>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1 text-[10px]">
              {mediaAssets.map((a) => (
                <option key={a.id} value={a.id} className="bg-card">{a.name}</option>
              ))}
            </select>
          </div>
          <Button size="sm" className="mt-1.5 h-6 w-full text-[10px]" disabled={!!job}
            onClick={() => void transcribe()}>
            {job ? `Transcribing… ${Math.round(job.p * 100)}%` : "Transcribe locally"}
          </Button>
          {modelsQ.data && !modelsQ.data.some((m) => m.present) && (
            <p className="mt-1 text-[9px] text-warning">
              No model installed — download one ({Math.round((modelsQ.data[0]?.sizeBytes ?? 0) / 1e6)} MB+) first.
            </p>
          )}
        </div>

        {/* Timing tools */}
        <div className="rounded border border-border/60 p-2">
          <p className="mb-1.5 flex items-center gap-1 font-medium"><Clock className="size-3" /> Timing</p>
          <div className="flex items-center gap-1">
            <input value={shift} onChange={(e) => setShift(e.target.value)}
              className="h-6 w-14 rounded border border-border bg-transparent px-1 text-[10px]" placeholder="±ms" />
            <Button variant="ghost" size="sm" className="h-6 flex-1 text-[10px]"
              onClick={() => { const d = parseInt(shift); if (d) mutate((doc) => shiftAllCues(doc, d)); }}>
              Shift all
            </Button>
            <Button variant="ghost" size="sm" className="h-6 flex-1 text-[10px]"
              onClick={() => mutate((d) => fixOverlaps(d))}>
              Fix overlaps
            </Button>
          </div>
          <div className="mt-1 flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 flex-1 text-[10px]"
              onClick={() => mutate((d) => scaleCueTimes(d, 1.1))}>Slower ×1.1</Button>
            <Button variant="ghost" size="sm" className="h-6 flex-1 text-[10px]"
              onClick={() => mutate((d) => scaleCueTimes(d, 0.9))}>Faster ×0.9</Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]"
              onClick={() => setIssues(diagnoseCues(doc))}>
              <ListChecks className="mr-1 size-3" />Check
            </Button>
          </div>
          {issues && (
            <div className="mt-1 max-h-16 space-y-0.5 overflow-y-auto">
              {issues.length === 0 && <p className="text-[9px] text-emerald-400">No timing issues.</p>}
              {issues.map((i) => (
                <button key={i.cueId + i.kind}
                  className="block w-full truncate text-left text-[9px] text-amber-300 hover:underline"
                  onClick={() => {
                    const c = cues.find((x) => x.id === i.cueId);
                    if (c) setPlayhead(c.startMs);
                  }}>
                  {i.kind}: {i.detail}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Style */}
        <div className="rounded border border-border/60 p-2">
          <p className="mb-1.5 flex items-center gap-1 font-medium">
            <Wand2 className="size-3" /> Style {versionId && <span className="text-[9px] text-accent-foreground">· version</span>}
          </p>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {SUBTITLE_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => setStyle(p.style)}
                title={p.label}
                className="w-16 shrink-0 overflow-hidden rounded-md border-2 border-border transition-all hover:border-accent"
              >
                <div className="flex h-9 items-center justify-center bg-[#0d0d12] px-0.5">
                  <span
                    className="text-center text-[8px] leading-tight"
                    style={{
                      color: p.style.text.color,
                      fontWeight: 600,
                      textShadow:
                        p.style.text.outlineWidth > 0 && p.style.text.outlineColor
                          ? `0 0 ${Math.min(3, p.style.text.outlineWidth)}px ${p.style.text.outlineColor}`
                          : undefined,
                    }}
                  >
                    Your <span style={{ color: p.style.highlightColor }}>captions</span>
                  </span>
                </div>
                <div className="bg-card px-1 py-0.5 text-center text-[7px] text-muted-foreground">
                  {p.label}
                </div>
              </button>
            ))}
          </div>
          <div className="mt-1 text-[10px]">
            <label className="mb-1 block text-muted-foreground">Animation</label>
            <div className="grid grid-cols-3 gap-1">
              {([
                ["none", "Static", "Plain cue text"],
                ["karaoke", "Karaoke", "Word-by-word highlight"],
                ["pop", "Pop", "Word pops in"],
              ] as const).map(([mode, label, hint]) => (
                <button
                  key={mode}
                  onClick={() => setStyle({ mode })}
                  title={hint}
                  className={`rounded-md border px-1 py-1.5 text-center transition-colors ${
                    (style?.mode ?? "none") === mode
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent"
                  }`}
                >
                  <div className="text-[9px] font-medium">{label}</div>
                  <div className="text-[7px] opacity-70">{hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1 grid grid-cols-3 items-center gap-1 text-[10px]">
            <label>Size</label>
            <input type="number" value={style?.text.fontSizePx ?? 32}
              onChange={(e) => style && setStyle({ text: { ...style.text, fontSizePx: +e.target.value } })}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1" />
            <label>Margin V</label>
            <input type="number" value={style?.marginVPx ?? 48}
              onChange={(e) => setStyle({ marginVPx: +e.target.value })}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1" />
          </div>
        </div>

        {/* Export */}
        <div className="flex gap-1">
          {(["srt", "vtt", "ass"] as const).map((f) => (
            <Button key={f} variant="secondary" size="sm" className="h-6 flex-1 text-[10px]"
              onClick={() => void exportAs(f)}>
              <Download className="mr-1 size-3" />{f.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

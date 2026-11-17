import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Captions,
  CheckCircle2,
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
  XCircle,
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
  removeSubtitleStyle,
  saveSubtitleStyle,
  scaleCueTimes,
  setVersionSubtitleStyle,
  shiftAllCues,
  splitCue,
  updateCue,
} from "@/lib/timeline-engine";
import { SUBTITLE_PRESETS } from "@/lib/subtitle-presets";
import { fontFamilyFor } from "@/lib/fonts";

/** System families offered in the font picker (no file needed). */
const BUILTIN_FONTS = [
  "Arial",
  "Arial Black",
  "Impact",
  "Bahnschrift",
  "Segoe UI",
  "Verdana",
  "Trebuchet MS",
  "Georgia",
  "Courier New",
  "Comic Sans MS",
  "Times New Roman",
];
import type { AssetSummary } from "@/lib/media-types";
import type { SubtitleCue } from "@/lib/project-types";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/errors";

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

  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [model, setModel] = useState("ggml-tiny.bin");
  const [lang, setLang] = useState("auto");
  const [sourceId, setSourceId] = useState("");
  const [job, setJob] = useState<{ id: string; p: number } | null>(null);
  /** Active model downloads: model name → job id + progress. */
  const [dls, setDls] = useState<Record<string, { id: string; p: number }>>({});
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [shift, setShift] = useState("0");
  const [issues, setIssues] = useState<ReturnType<typeof diagnoseCues> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const modelsQ = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const selModel = modelsQ.data?.find((m) => m.name === model);
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

  /** Explicit user-initiated model download (job-driven: real progress,
   * cancel, resume from `.part`). Auto-selects the model on success. */
  const download = async (name: string) => {
    if (dls[name]) return;
    const id = await api.downloadModel(name).catch((e) => {
      toast.error(t("subs.dlFailed"), { description: String(e) });
      return null;
    });
    if (!id) return;
    setDls((s) => ({ ...s, [name]: { id, p: 0 } }));
    const off = onJobProgress((e) => {
      if (e.jobId === id)
        setDls((s) => (s[name] ? { ...s, [name]: { id, p: e.progress } } : s));
    });
    const fin = await awaitJob(id);
    off();
    setDls((s) => {
      const n = { ...s };
      delete n[name];
      return n;
    });
    if (fin.status === "done") {
      await qc.invalidateQueries({ queryKey: ["models"] });
      setModel(name);
      toast.success(t("subs.dlDone"));
    } else if (fin.status !== "cancelled") {
      toast.error(t("subs.dlFailed"), { description: fin.error ?? undefined });
    }
    void qc.invalidateQueries({ queryKey: ["models"] });
  };

  const cancelDl = async (name: string) => {
    const d = dls[name];
    if (d) await api.cancelJob(d.id).catch(() => {});
  };

  const transcribe = async () => {
    const src = sourceId ? assets.get(sourceId)?.filePath : mediaAssets[0]?.filePath;
    if (!src || !filePath) return toast.error(t("subs.importFirst"));
    // Transcription writes cues into the saved project — save first.
    await useProject.getState().save();
    const id = await api.transcribeMedia(filePath, src, model, lang).catch((e) => {
      reportError(e);
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
      toast.success(t("subs.cuesDone", { cues: r.cues ?? 0, words: r.withWords ?? 0 }));
    } catch (e) {
      reportError(e);
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
      .catch((e) => reportError(e));
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
            <button title={t("subs.splitAtPlayhead")} className="p-0.5 hover:text-accent-foreground"
              onClick={(e) => { e.stopPropagation(); mutate((d) => splitCue(d, cue.id, playheadMs)?.doc ?? d); }}>
              <Scissors className="size-3" />
            </button>
            <button title={t("subs.mergeNext")} className="p-0.5 hover:text-accent-foreground"
              onClick={(e) => { e.stopPropagation(); mutate((d) => mergeCueWithNext(d, cue.id)?.doc ?? d); }}>
              <Merge className="size-3" />
            </button>
            <button title={t("subs.duplicateCue")} className="p-0.5 hover:text-accent-foreground"
              onClick={(e) => { e.stopPropagation(); mutate((d) => duplicateCue(d, cue.id)?.doc ?? d); }}>
              <Plus className="size-3" />
            </button>
            <button title={t("subs.deleteCue")} className="p-0.5 hover:text-destructive"
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
          <input placeholder={t("subs.findPh")} value={find} onChange={(e) => setFind(e.target.value)}
            className="h-6 w-24 rounded border border-border bg-transparent px-1.5 text-[10px]" />
          <input placeholder={t("subs.replacePh")} value={replace} onChange={(e) => setReplace(e.target.value)}
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
              title={t("subs.noCaptions")}
              body={t("subs.noCaptionsBody")}
              action={{
                label: t("subs.addCue"),
                onClick: () =>
                  mutate((d) => addCue(d, { startMs: playheadMs, endMs: playheadMs + 2000, text: t("subs.newCueSeed"), words: [] }).doc),
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
          <p className="mb-1.5 flex items-center gap-1 font-medium"><Mic2 className="size-3" /> {t("subs.transcribe")}</p>
          <div className="grid grid-cols-2 gap-1">
            <select value={lang} onChange={(e) => setLang(e.target.value)}
              className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
              aria-label={t("subs.language")}>
              {["auto","en","es","fr","de","pt","it","ja","zh"].map((l) => (
                <option key={l} value={l} className="bg-card">{l === "auto" ? t("subs.autoDetect") : l}</option>
              ))}
            </select>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}
              className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
              aria-label={t("subs.source")}>
              {mediaAssets.map((a) => (
                <option key={a.id} value={a.id} className="bg-card">{a.name}</option>
              ))}
            </select>
          </div>

          {/* Model picker: installed models are selectable; missing ones
              offer an explicit download (or resume a `.part`). */}
          <div className="mt-1.5 space-y-1">
            {modelsQ.data?.map((m) => {
              const dl = dls[m.name];
              const chosen = model === m.name;
              return (
                <div key={m.name}
                  className={`flex items-center gap-1.5 rounded border px-1.5 py-1 text-[10px] ${
                    chosen && m.present ? "border-primary/60 bg-primary/5" : "border-border/50"
                  }`}>
                  <button
                    className="flex flex-1 items-center gap-1.5 text-left disabled:opacity-60"
                    disabled={!m.present}
                    onClick={() => setModel(m.name)}
                  >
                    <span className={`font-medium ${m.present ? "" : "text-muted-foreground"}`}>
                      {m.name.replace("ggml-", "").replace(".bin", "")}
                    </span>
                    <span className="text-muted-foreground">
                      {t(`subs.tier_${m.tier.split(" ")[0]}`, { defaultValue: m.tier })}
                      {" · "}
                      {t("subs.sizeMb", { mb: Math.round(m.sizeBytes / 1e6) })}
                    </span>
                  </button>
                  {m.present ? (
                    chosen ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-label={t("subs.installed")} />
                    ) : (
                      <span className="text-[9px] text-muted-foreground">{t("subs.installed")}</span>
                    )
                  ) : dl ? (
                    <span className="flex items-center gap-1">
                      <span className="h-1 w-14 overflow-hidden rounded-full bg-secondary">
                        <span className="block h-full bg-primary" style={{ width: `${Math.round(dl.p * 100)}%` }} />
                      </span>
                      <button
                        className="text-muted-foreground hover:text-foreground"
                        title={t("subs.cancelDl")}
                        aria-label={t("subs.cancelDl")}
                        onClick={() => void cancelDl(m.name)}
                      >
                        <XCircle className="size-3.5" />
                      </button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 shrink-0 px-1.5 text-[10px]"
                      onClick={() => void download(m.name)}
                    >
                      <Download className="size-3" />
                      {m.partialBytes > 0
                        ? t("subs.resume")
                        : t("subs.download")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          <Button size="sm" className="mt-1.5 h-6 w-full text-[10px]"
            disabled={!!job || !selModel?.present}
            onClick={() => void transcribe()}>
            {job ? `${t("subs.transcribing")} ${Math.round(job.p * 100)}%` : t("subs.transcribeBtn")}
          </Button>
          {modelsQ.data && !modelsQ.data.some((m) => m.present) && (
            <p className="mt-1 text-[9px] text-warning">
              {t("subs.noModelWarn")}
            </p>
          )}
        </div>

        {/* Timing tools */}
        <div className="rounded border border-border/60 p-2">
          <p className="mb-1.5 flex items-center gap-1 font-medium"><Clock className="size-3" />{t("subs.timing")}</p>
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
              onClick={() => mutate((d) => scaleCueTimes(d, 1.1))}>{t("subs.slower")}</Button>
            <Button variant="ghost" size="sm" className="h-6 flex-1 text-[10px]"
              onClick={() => mutate((d) => scaleCueTimes(d, 0.9))}>{t("subs.faster")}</Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]"
              onClick={() => setIssues(diagnoseCues(doc))}>
              <ListChecks className="mr-1 size-3" />Check
            </Button>
          </div>
          {issues && (
            <div className="mt-1 max-h-16 space-y-0.5 overflow-y-auto">
              {issues.length === 0 && <p className="text-[9px] text-emerald-400">{t("subs.noTimingIssues")}</p>}
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
            <Wand2 className="size-3" /> Style {versionId && <span className="text-[9px] text-accent-foreground">{t("subs.versionLbl")}</span>}
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
                      fontFamily: fontFamilyFor(p.style.text.fontFile) ?? p.style.text.fontName ?? undefined,
                      fontWeight: 600,
                      textShadow:
                        p.style.text.outlineWidth > 0 && p.style.text.outlineColor
                          ? `0 0 ${Math.min(3, p.style.text.outlineWidth)}px ${p.style.text.outlineColor}`
                          : undefined,
                    }}
                  >
                    Your <span style={{ color: p.style.highlightColor }}>{t("subs.captions")}</span>
                  </span>
                </div>
                <div className="bg-card px-1 py-0.5 text-center text-[7px] text-muted-foreground">
                  {p.label}
                </div>
              </button>
            ))}
          </div>
          <div className="mt-1 text-[10px]">
            <label className="mb-1 block text-muted-foreground">{t("subs.animation")}</label>
            <div className="grid grid-cols-5 gap-1">
              {([
                ["none", "Static", "Plain text"],
                ["karaoke", "Karaoke", "Word fill"],
                ["pop", "Pop", "One word"],
                ["jump", "Jumpy", "Word bounce"],
                ["impact", "Impact", "Slam in"],
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
          {style && (
            <div className="mt-1 flex items-center gap-1.5">
              {(
                [
                  ["color", t("subs.colorText")],
                  ["outlineColor", t("subs.colorOutline")],
                  ["highlightColor", t("subs.colorHi")],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex flex-1 items-center gap-1 text-[9px] text-muted-foreground">
                  <input
                    type="color"
                    className="h-5 w-7 cursor-pointer rounded border border-border bg-transparent p-0"
                    value={((key === "highlightColor" ? style.highlightColor : style.text[key]) ?? "#FFFFFF").slice(0, 7)}
                    onChange={(e) =>
                      key === "highlightColor"
                        ? setStyle({ highlightColor: e.target.value })
                        : setStyle({ text: { ...style.text, [key]: e.target.value } })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          {style && (
            <div className="mt-1 flex items-center gap-1.5">
              {(
                [
                  ["backgroundColor", t("subs.bg"), "#000000B0"],
                  ["shadowColor", t("subs.shadow"), "#000000C0"],
                ] as const
              ).map(([key, label, def]) => {
                const on = style.text[key] != null;
                return (
                  <label key={key} className="flex flex-1 items-center gap-1 text-[9px] text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3"
                      checked={on}
                      onChange={(e) =>
                        setStyle({
                          text: {
                            ...style.text,
                            [key]: e.target.checked ? def : null,
                            ...(key === "shadowColor" && e.target.checked && !style.text.shadowX && !style.text.shadowY
                              ? { shadowX: 2, shadowY: 2 }
                              : {}),
                          },
                        })
                      }
                    />
                    <input
                      type="color"
                      className="h-5 w-7 cursor-pointer rounded border border-border bg-transparent p-0 disabled:opacity-40"
                      disabled={!on}
                      value={(style.text[key] ?? def).slice(0, 7)}
                      onChange={(e) =>
                        setStyle({
                          text: {
                            ...style.text,
                            [key]: (style.text[key] ?? "").length === 9 ? `${e.target.value}${style.text[key]!.slice(7)}` : e.target.value,
                          },
                        })
                      }
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          )}
          {style && (
            <select
              className="mt-1 h-6 w-full rounded border border-border bg-transparent px-1 text-[10px]"
              value={style.text.fontFile ? `file:${style.text.fontFile}` : style.text.fontName ? `name:${style.text.fontName}` : ""}
              onChange={(e) => {
                const v = e.target.value;
                const t2 = { ...style.text };
                if (v.startsWith("file:")) { t2.fontFile = v.slice(5); t2.fontName = null; }
                else if (v.startsWith("name:")) { t2.fontFile = null; t2.fontName = v.slice(5); }
                else { t2.fontFile = null; t2.fontName = null; }
                setStyle({ text: t2 });
              }}
            >
              <option value="">{t("gfxI.fontDefault")}</option>
              <optgroup label={t("subs.fontBuiltin")}>
                {BUILTIN_FONTS.map((f) => (
                  <option key={f} value={`name:${f}`}>{f}</option>
                ))}
              </optgroup>
              {(doc.brandKit?.fonts?.length ?? 0) > 0 && (
                <optgroup label={t("subs.fontBrand")}>
                  {doc.brandKit!.fonts.map((f) => (
                    <option key={f.path} value={`file:${f.path}`}>{f.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {/* Saved styles — live in the project; per-cue via lane menu. */}
          <div className="mt-1.5 flex items-center gap-1">
            <button
              className="flex h-6 items-center gap-0.5 rounded border border-border px-1.5 text-[9px] text-muted-foreground hover:bg-accent"
              title={t("subs.saveStyle")}
              onClick={() => {
                const name = window.prompt(t("subs.saveStylePrompt"), "");
                if (name == null || !style) return;
                mutate((d) => saveSubtitleStyle(d, name, style).doc);
                toast.success(t("subs.styleSaved", { name }));
              }}
            >
              <Plus className="size-3" /> {t("subs.saveStyle")}
            </button>
            <div className="flex flex-1 gap-1 overflow-x-auto">
              {(doc.subtitleStyles ?? []).map((s) => (
                <span key={s.id} className="group flex shrink-0 items-center rounded border border-border">
                  <button
                    className="px-1.5 py-0.5 text-[9px] hover:bg-accent"
                    style={{ color: s.style.text.color }}
                    title={t("subs.applyStyleTip")}
                    onClick={() => setStyle(s.style)}
                  >
                    {s.name}
                  </button>
                  <button
                    className="px-0.5 text-muted-foreground/50 hover:text-destructive"
                    title={t("subs.deleteStyle")}
                    onClick={() => mutate((d) => removeSubtitleStyle(d, s.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="mt-1 grid grid-cols-3 items-center gap-1 text-[10px]">
            <label>{t("subs.size")}</label>
            <input type="number" value={style?.text.fontSizePx ?? 32}
              onChange={(e) => style && setStyle({ text: { ...style.text, fontSizePx: +e.target.value } })}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1" />
            <label>{t("subs.marginV")}</label>
            <input type="number" value={style?.marginVPx ?? 48}
              onChange={(e) => setStyle({ marginVPx: +e.target.value })}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1" />
            <label>{t("subs.outlineW")}</label>
            <input type="number" value={style?.text.outlineWidth ?? 0}
              onChange={(e) => style && setStyle({ text: { ...style.text, outlineWidth: +e.target.value } })}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1" />
            <label>{t("subs.bgPad")}</label>
            <input type="number" value={style?.text.backgroundPadPx ?? 0} disabled={!style?.text.backgroundColor}
              onChange={(e) => style && setStyle({ text: { ...style.text, backgroundPadPx: +e.target.value } })}
              className="col-span-2 h-6 rounded border border-border bg-transparent px-1 disabled:opacity-40" />
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

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  FileVideo,
  Loader2,
  Minus,
  Plus,
  Scissors,
  Search,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { awaitJob, onJobProgress } from "@/services/jobs";
import { reportError } from "@/lib/errors";
import type { AssetSummary } from "@/lib/media-types";
import { presetById } from "@/lib/format-presets";
import { SUBTITLE_PRESETS } from "@/lib/subtitle-presets";
import {
  LENGTH_PRESETS,
  DEFAULT_TARGET_IDS,
  TARGET_PRESET_IDS,
  buildClipDoc,
  captionFromText,
  clampRange,
  platformOfPreset,
  type AnalyzeResult,
  type Candidate,
  type MotionSample,
} from "@/lib/repurpose";
import { useOpenInEditor } from "@/lib/open-in-editor";
import { setDragPayload } from "@/lib/drag-payload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PlatformIcon } from "@/modules/social/PlatformIcon";
import { cn } from "@/lib/utils";

interface Row extends Candidate {
  selected: boolean;
}

interface Made {
  title: string;
  ok: boolean;
  projectPath?: string;
  postId?: string;
  error?: string;
  /** Batch export outcome for this clip. */
  exported?: { ok: number; failed: number; file?: string };
}

const COUNTS = [3, 5, 8, 10];
const PREFERRED_MODEL = "ggml-base.bin";
const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Plays only the clip's window; loops back to the start at the end. */
function ClipPreview({ src, startMs, endMs }: { src: string; startMs: number; endMs: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const seek = () => {
    if (ref.current) ref.current.currentTime = startMs / 1000;
  };
  useEffect(seek, [startMs]);
  return (
    <video
      ref={ref}
      src={src}
      controls
      preload="metadata"
      className="aspect-video w-48 shrink-0 rounded-md border border-border bg-black object-contain"
      onLoadedMetadata={seek}
      onPlay={() => {
        const v = ref.current;
        if (v && (v.currentTime < startMs / 1000 - 0.2 || v.currentTime >= endMs / 1000)) seek();
      }}
      onTimeUpdate={() => {
        const v = ref.current;
        if (v && v.currentTime >= endMs / 1000) {
          v.pause();
          seek();
        }
      }}
    />
  );
}

function Stepper({
  label,
  valueMs,
  onChange,
}: {
  label: string;
  valueMs: number;
  onChange: (ms: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="w-9 text-muted-foreground">{label}</span>
      <Button
        size="sm"
        variant="ghost"
        className="size-6 p-0"
        aria-label={`${label} −1s`}
        onClick={() => onChange(valueMs - 1000)}
      >
        <Minus className="size-3" />
      </Button>
      <span className="w-12 text-center tabular-nums" title={t("rp.seconds", { s: (valueMs / 1000).toFixed(1) })}>
        {fmtTime(valueMs)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="size-6 p-0"
        aria-label={`${label} +1s`}
        onClick={() => onChange(valueMs + 1000)}
      >
        <Plus className="size-3" />
      </Button>
    </div>
  );
}

export function RepurposePage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { openPath } = useOpenInEditor();

  const { data: assets } = useQuery({
    queryKey: ["repurpose-assets"],
    queryFn: () => api.listAssets({ kind: "video" }),
    staleTime: 0,
  });
  const { data: models, refetch: refetchModels } = useQuery({
    queryKey: ["repurpose-models"],
    queryFn: () => api.listModels(),
  });

  const [assetId, setAssetId] = useState("");
  const [libQuery, setLibQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [lengthId, setLengthId] = useState<(typeof LENGTH_PRESETS)[number]["id"]>("standard");
  const [count, setCount] = useState(5);
  const [language, setLanguage] = useState("auto");
  const [modelName, setModelName] = useState("");
  const [targets, setTargets] = useState<string[]>(DEFAULT_TARGET_IDS);
  const [captions, setCaptions] = useState(true);
  const [styleId, setStyleId] = useState("bold-social");
  const [follow, setFollow] = useState(true);

  const [busy, setBusy] = useState<null | "analyze" | "model" | "generate">(null);
  const [progress, setProgress] = useState<{ p: number; label?: string } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [made, setMade] = useState<Made[] | null>(null);
  const [genStep, setGenStep] = useState<{ n: number; total: number; step: string } | null>(null);
  const [exp, setExp] = useState<{ n: number; total: number } | null>(null);

  const asset: AssetSummary | undefined = useMemo(
    () => assets?.find((a) => a.id === assetId),
    [assets, assetId],
  );
  const usableAssets = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    return (assets ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [assets, libQuery]);
  const presentModels = useMemo(() => (models ?? []).filter((m) => m.present), [models]);
  const model = modelName || presentModels.find((m) => m.name === PREFERRED_MODEL)?.name || presentModels[0]?.name || "";

  useEffect(
    () =>
      onJobProgress((e) => {
        if (jobId && e.jobId === jobId) setProgress({ p: e.progress, label: e.label });
      }),
    [jobId],
  );

  const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);

  const importPaths = async (paths: string[]) => {
    const vids = paths.filter((p) => VIDEO_EXT.has(p.split(".").pop()?.toLowerCase() ?? ""));
    if (vids.length === 0) return;
    setBusy("model");
    try {
      const id = await api.importMedia(vids);
      const fin = await awaitJob<{ imported?: { id: string }[] }>(id);
      const first = fin.result?.imported?.[0];
      await qc.invalidateQueries({ queryKey: ["repurpose-assets"] });
      if (first) {
        setAssetId(first.id);
        reset();
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const importVideo = async () => {
    const f = await openDialog({
      title: t("rp.importVideo"),
      filters: [{ name: "Video", extensions: [...VIDEO_EXT] }],
    });
    if (!f || Array.isArray(f)) return;
    void importPaths([f]);
  };

  // OS file drops arrive as DOM drops whose File objects carry no path
  // (Tauri's native drop handler is disabled for in-app HTML5 DnD). The page
  // forwards the File objects to the host; Rust answers with real paths on
  // this channel. Same bridge as LibraryPage — see external_drop.rs.
  useEffect(() => {
    const unlistenTauri = getCurrentWindow().onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        setDragOver(false);
        void importPaths(e.payload.paths);
      }
    });
    const unlistenDrop = listen<string[]>("creatora://external-file-drop", (e) => {
      void importPaths(e.payload);
    });
    return () => {
      void unlistenTauri.then((f) => f());
      void unlistenDrop.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptsDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files") ||
    e.dataTransfer.types.includes("application/x-creatora-asset");

  const onSourceDragOver = (e: React.DragEvent) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };
  const onSourceDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  };
  const onSourceDrop = (e: React.DragEvent) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    setDragOver(false);
    const assetDrag = e.dataTransfer.getData("application/x-creatora-asset");
    if (assetDrag && (assets ?? []).some((a) => a.id === assetDrag)) {
      setAssetId(assetDrag);
      reset();
      return;
    }
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    const wv = (window as unknown as {
      chrome?: { webview?: { postMessageWithAdditionalObjects?: (m: string, o: ArrayLike<object>) => void } };
    }).chrome?.webview;
    wv?.postMessageWithAdditionalObjects?.("__CREATORA_EXT_DROP__", files);
  };

  const downloadModel = async () => {
    setBusy("model");
    try {
      const id = await api.downloadModel(PREFERRED_MODEL);
      setJobId(id);
      await awaitJob(id);
      await refetchModels();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
      setProgress(null);
      setJobId(null);
    }
  };

  const analyze = async () => {
    if (!asset || !model) return;
    const len = LENGTH_PRESETS.find((l) => l.id === lengthId)!;
    setBusy("analyze");
    setProgress({ p: 0 });
    setResult(null);
    setRows([]);
    setMade(null);
    try {
      const id = await api.repurposeAnalyze({
        path: asset.filePath,
        model,
        language,
        minMs: len.minMs,
        idealMs: len.idealMs,
        maxMs: len.maxMs,
        count,
      });
      setJobId(id);
      const fin = await awaitJob<AnalyzeResult>(id);
      if (fin.status === "done" && fin.result) {
        setResult(fin.result);
        setRows(fin.result.candidates.map((c) => ({ ...c, selected: true })));
      } else if (fin.status === "failed") {
        toast.error(t("common.error"), {
          description: /whisper|transcri/i.test(fin.error ?? "") ? t("rp.errTranscribe") : fin.error,
        });
      }
    } catch (e) {
      if (String(e instanceof Error ? e.message : e).includes("no_audio")) {
        toast.error(t("rp.errNoAudio"));
      } else {
        reportError(e);
      }
    } finally {
      setBusy(null);
      setProgress(null);
      setJobId(null);
    }
  };

  const patchRow = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const trim = (r: Row, which: "start" | "end", ms: number) => {
    if (!asset?.durationMs) return;
    const next = clampRange(which === "start" ? ms : r.startMs, which === "end" ? ms : r.endMs, asset.durationMs);
    patchRow(r.id, next);
  };

  const selected = rows.filter((r) => r.selected);
  const canCreate = selected.length > 0 && targets.length > 0 && busy === null;

  const generate = async () => {
    if (!asset || !result || !canCreate) return;
    // The source may have been removed from the library (or its file moved)
    // since the analysis ran — projects can't reference a vanished asset.
    const fresh = await api.listAssets({ kind: "video" });
    const live = fresh.find((a) => a.id === asset.id);
    if (!live || live.status === "missing") {
      toast.error(t("rp.errSourceGone"));
      void qc.invalidateQueries({ queryKey: ["repurpose-assets"] });
      setAssetId("");
      reset();
      return;
    }
    const ids = TARGET_PRESET_IDS.filter((id) => targets.includes(id));
    const master = presetById(ids[0]!)!;
    const style = SUBTITLE_PRESETS.find((s) => s.id === styleId)!.style;
    setBusy("generate");
    const out: Made[] = [];
    try {
      for (let i = 0; i < selected.length; i++) {
        const r = selected[i]!;
        const title = r.title.trim() || t("rp.clipN", { n: i + 1 });
        const step = (s: string) => setGenStep({ n: i + 1, total: selected.length, step: s });
        let createdId: string | null = null;
        try {
          step(t("rp.gen_project"));
          const proj = await api.createProject({
            name: `${asset.name.replace(/\.[^.]+$/, "")} — ${title}`.slice(0, 80),
            width: master.canvas.width,
            height: master.canvas.height,
            fpsNum: result.fpsNum || 30,
            fpsDen: result.fpsDen || 1,
          });
          createdId = proj.doc.meta.id;
          let motion: MotionSample[] | undefined;
          if (follow) {
            step(t("rp.gen_motion"));
            const id = await api.analyzeSubject(asset.filePath, r.startMs, r.endMs, 24);
            const fin = await awaitJob<MotionSample[]>(id);
            if (fin.status === "done" && fin.result?.length) motion = fin.result;
          }
          const built = buildClipDoc({
            base: proj.doc,
            asset: {
              id: asset.id,
              filePath: asset.filePath,
              width: asset.width ?? master.canvas.width,
              height: asset.height ?? master.canvas.height,
              durationMs: asset.durationMs,
            },
            startMs: r.startMs,
            endMs: r.endMs,
            cues: result.cues,
            presetIds: ids,
            captions,
            captionStyle: style,
            motion,
          });
          await api.saveProject(proj.filePath, built.doc);

          step(t("rp.gen_post"));
          const seen = new Set<string>();
          const postTargets = ids.flatMap((pid) => {
            const platform = platformOfPreset(presetById(pid)!);
            const versionId = built.versionByPreset[pid] ?? null;
            const key = `${platform}|${versionId ?? ""}`;
            if (!platform || seen.has(key)) return [];
            seen.add(key);
            return [{ platform, versionId, platformMeta: {}, autoPublish: false, scheduledAt: null }];
          });
          const post = await api.saveSocialPost(
            null,
            {
              projectId: built.doc.meta.id,
              title,
              caption: captionFromText(r.text),
              hashtags: [],
              targets: postTargets,
            },
            false,
          );
          out.push({ title, ok: true, projectPath: proj.filePath, postId: post.id });
        } catch (e) {
          // Never leave a half-built project behind.
          if (createdId) await api.deleteProject(createdId, true).catch(() => undefined);
          const msg = e instanceof Error ? e.message : String(e);
          out.push({
            title,
            ok: false,
            error: /FOREIGN KEY/i.test(msg) ? t("rp.errSourceGone") : msg,
          });
        }
      }
    } finally {
      setBusy(null);
      setGenStep(null);
      setMade(out);
      void qc.invalidateQueries({ queryKey: ["social-thumbs"] });
    }
  };

  /** Export every target of every created clip, one at a time (FFmpeg is
   *  CPU-bound); each post lands in its own subfolder of the chosen folder. */
  const exportAll = async () => {
    if (!made) return;
    const dir = await openDialog({ directory: true, title: t("rp.exportAll") });
    if (!dir || Array.isArray(dir)) return;
    const jobs: { i: number; targetId: string }[] = [];
    for (const [i, m] of made.entries()) {
      if (!m.ok || !m.postId) continue;
      const post = await api.getSocialPost(m.postId);
      for (const tg of post.targets) jobs.push({ i, targetId: tg.id });
    }
    const next = made.map((m) => ({ ...m, exported: { ok: 0, failed: 0 } as NonNullable<Made["exported"]> }));
    setExp({ n: 0, total: jobs.length });
    for (const [k, j] of jobs.entries()) {
      setExp({ n: k + 1, total: jobs.length });
      try {
        const id = await api.exportForTarget(j.targetId, dir);
        const fin = await awaitJob<{ filePath?: string }>(id);
        const e = next[j.i]!.exported!;
        if (fin.status === "done") {
          e.ok++;
          e.file ??= fin.result?.filePath;
        } else {
          e.failed++;
        }
      } catch {
        next[j.i]!.exported!.failed++;
      }
      setMade([...next]);
    }
    setExp(null);
    const ok = next.reduce((n, m) => n + (m.exported?.ok ?? 0), 0);
    const bad = next.reduce((n, m) => n + (m.exported?.failed ?? 0), 0);
    if (ok) toast.success(t("rp.exportedN", { n: ok }), { description: dir });
    if (bad) toast.error(t("rp.exportFailedN", { n: bad }));
  };

  const reset = () => {
    setResult(null);
    setRows([]);
    setMade(null);
  };

  const needModel = models && presentModels.length === 0;

  // ───────────── finished ─────────────
  if (made) {
    const ok = made.filter((m) => m.ok);
    const failed = made.filter((m) => !m.ok);
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-6 text-success" />
          <div>
            <h1 className="text-lg font-semibold">{t("rp.done")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("rp.doneBody", { ok: ok.length })}
              {failed.length > 0 && ` · ${t("rp.failedN", { n: failed.length })}`}
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {made.map((m, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
              {m.ok ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <XCircle className="size-4 shrink-0 text-destructive" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{m.title}</p>
                {m.error && <p className="truncate text-xs text-destructive">{m.error}</p>}
              </div>
              {m.exported && m.exported.ok > 0 && (
                <button
                  className="shrink-0 rounded border border-success/40 px-1.5 py-0.5 text-[10px] text-success hover:bg-success/10"
                  title={m.exported.file}
                  onClick={() => m.exported?.file && void api.revealPath(m.exported.file)}
                >
                  {t("rp.exportedN", { n: m.exported.ok })} · {t("rp.showFolder")}
                </button>
              )}
              {m.exported && m.exported.failed > 0 && (
                <span className="shrink-0 text-[10px] text-destructive">
                  {t("rp.exportFailedN", { n: m.exported.failed })}
                </span>
              )}
              {m.ok && m.projectPath && (
                <Button size="sm" variant="secondary" onClick={() => void openPath(m.projectPath!)}>
                  {t("rp.openEditor")}
                </Button>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={exp !== null || ok.length === 0} onClick={() => void exportAll()}>
            {exp ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Download className="mr-1.5 size-4" />}
            {exp ? t("rp.exporting", { n: exp.n, total: exp.total }) : t("rp.exportAll")}
          </Button>
          <Button variant="secondary" onClick={() => nav("/social")}>
            {t("rp.openSocial")}
          </Button>
          <Button variant="ghost" onClick={() => setMade(null)}>
            {t("rp.back")}
          </Button>
          <Button variant="ghost" onClick={reset}>
            {t("rp.again")}
          </Button>
        </div>
      </div>
    );
  }

  // ───────────── setup + review ─────────────
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6 pb-28">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Scissors className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">{t("rp.title")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("rp.subtitle")}</p>
        </div>
      </div>

      {/* 1 · source */}
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t("rp.stepSource")}</h2>
        <div
          onDragOver={onSourceDragOver}
          onDragLeave={onSourceDragLeave}
          onDrop={onSourceDrop}
          aria-label={t("rp.dropVideo")}
          className={cn(
            "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors",
            dragOver
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground",
          )}
        >
          <Upload className="size-5" />
          <p className="text-sm font-medium">{t("rp.dropVideo")}</p>
          <p className="text-xs">{t("rp.orPickLibrary")}</p>
        </div>
        {assets && assets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("rp.noVideos")}</p>
        ) : (
          <>
            {(assets ?? []).length > 6 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={libQuery}
                  onChange={(e) => setLibQuery(e.target.value)}
                  placeholder={t("rp.searchVideos")}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            )}
            <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4">
              {usableAssets.map((a) => {
                const sel = a.id === assetId;
                const missing = a.status === "missing";
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-rp-asset={a.id}
                    aria-pressed={sel}
                    disabled={busy !== null || missing}
                    draggable={!missing}
                    onClick={() => {
                      setAssetId(a.id);
                      reset();
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/x-creatora-asset", a.id);
                      e.dataTransfer.setData("application/x-creatora-path", a.filePath);
                      e.dataTransfer.setData("application/x-creatora-duration", String(a.durationMs ?? 3000));
                      e.dataTransfer.effectAllowed = "copy";
                      setDragPayload({
                        assetId: a.id,
                        filePath: a.filePath,
                        durationMs: a.durationMs ?? 3000,
                        kind: a.kind,
                      });
                    }}
                    onDragEnd={() => setDragPayload(null)}
                    className={cn(
                      "group relative cursor-grab overflow-hidden rounded-lg border text-left transition-colors",
                      sel
                        ? "border-primary ring-2 ring-primary/40"
                        : "border-border hover:border-primary/50",
                      missing && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <div className="relative aspect-video w-full bg-secondary">
                      {a.thumbnailPath ? (
                        <img
                          src={convertFileSrc(a.thumbnailPath)}
                          alt=""
                          draggable={false}
                          className="absolute inset-0 size-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Film className="size-6 text-muted-foreground" />
                        </div>
                      )}
                      {a.durationMs != null && (
                        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
                          {fmtTime(a.durationMs)}
                        </span>
                      )}
                      {sel && (
                        <span className="absolute left-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                          <CheckCircle2 className="size-3.5" />
                        </span>
                      )}
                      {missing && (
                        <span className="absolute left-1 top-1 rounded bg-warning/90 p-0.5 text-warning-foreground">
                          <AlertTriangle className="size-3.5" />
                        </span>
                      )}
                    </div>
                    <div className="truncate px-1.5 py-1 text-[11px]">{a.name}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void importVideo()}>
          <FileVideo className="mr-1.5 size-3.5" /> {t("rp.importVideo")}
        </Button>
      </section>

      {/* 2 · options */}
      <section className="space-y-4 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t("rp.stepOptions")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("rp.clipLength")}</p>
            <div className="flex flex-wrap gap-1.5">
              {LENGTH_PRESETS.map((l) => (
                <button
                  key={l.id}
                  aria-pressed={lengthId === l.id}
                  onClick={() => setLengthId(l.id)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs",
                    lengthId === l.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {t(`rp.len_${l.id}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("rp.howMany")}</p>
            <div className="flex gap-1.5">
              {COUNTS.map((n) => (
                <button
                  key={n}
                  aria-pressed={count === n}
                  onClick={() => setCount(n)}
                  className={cn(
                    "w-10 rounded-md border py-1 text-xs",
                    count === n ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="space-y-1.5 text-xs">
            <span className="font-medium text-muted-foreground">{t("rp.language")}</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="auto">{t("rp.langAuto")}</option>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          {presentModels.length > 0 && (
            <label className="space-y-1.5 text-xs">
              <span className="font-medium text-muted-foreground">{t("rp.model")}</span>
              <select
                value={model}
                onChange={(e) => setModelName(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {presentModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name.replace(/^ggml-|\.bin$/g, "")} · {m.tier}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {needModel && (
          <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
            <span className="flex-1">{t("rp.noModel")}</span>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void downloadModel()}>
              {busy === "model" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Download className="mr-1.5 size-3.5" />}
              {busy === "model" && progress
                ? `${t("rp.downloading")} ${Math.round(progress.p * 100)}%`
                : t("rp.downloadModel", {
                    mb: Math.round((models?.find((m) => m.name === PREFERRED_MODEL)?.sizeBytes ?? 0) / 1e6),
                  })}
            </Button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button disabled={!asset || !model || busy !== null} onClick={() => void analyze()}>
            {busy === "analyze" ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Sparkles className="mr-1.5 size-4" />}
            {busy === "analyze" ? t("rp.analyzing") : t("rp.analyze")}
          </Button>
          {busy === "analyze" && jobId && (
            <Button variant="ghost" size="sm" onClick={() => void api.cancelJob(jobId)}>
              {t("common.cancel")}
            </Button>
          )}
        </div>
        {busy === "analyze" && progress && (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.max(3, Math.round(progress.p * 100))}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress.label ? t(`rp.job_${slug(progress.label)}`, { defaultValue: progress.label }) : ""}
            </p>
          </div>
        )}
      </section>

      {/* results */}
      {result && (
        <section className="space-y-3">
          {rows.length === 0 ? (
            <EmptyState icon={Scissors} title={t("rp.found", { count: 0 })} body={t("rp.noResults")} compact />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">{t("rp.found", { count: rows.length })}</h2>
                {result.cached && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("rp.cached")}</span>
                )}
                <div className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: true })))}>
                  {t("rp.selectAll")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: false })))}>
                  {t("rp.selectNone")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("rp.foundHint")}</p>
              {rows.map((r) => (
                <article
                  key={r.id}
                  className={cn(
                    "flex gap-4 rounded-xl border bg-card p-3",
                    r.selected ? "border-primary/50" : "border-border opacity-70",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={(e) => patchRow(r.id, { selected: e.target.checked })}
                    aria-label={t("rp.clipN", { n: r.rank })}
                    className="mt-1 size-4 shrink-0 accent-[hsl(var(--primary))]"
                  />
                  {asset && <ClipPreview src={convertFileSrc(asset.filePath)} startMs={r.startMs} endMs={r.endMs} />}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                        #{r.rank}
                      </span>
                      <input
                        value={r.title}
                        onChange={(e) => patchRow(r.id, { title: e.target.value })}
                        aria-label={t("rp.titleLbl")}
                        className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm font-medium"
                      />
                      <span className="shrink-0 text-xs text-muted-foreground" title={t("rp.score")}>
                        {Math.round(r.score)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <Stepper label={t("rp.start")} valueMs={r.startMs} onChange={(ms) => trim(r, "start", ms)} />
                      <Stepper label={t("rp.end")} valueMs={r.endMs} onChange={(ms) => trim(r, "end", ms)} />
                      <span className="text-xs text-muted-foreground">
                        {t("rp.seconds", { s: Math.round((r.endMs - r.startMs) / 1000) })}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {r.reasons.map((c) => (
                        <span key={c} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t(`rp.reason_${c}`, { defaultValue: c })}
                        </span>
                      ))}
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground" title={r.text}>
                      {r.text}
                    </p>
                  </div>
                </article>
              ))}

              {/* 3 · targets + generate */}
              <section className="space-y-3 rounded-xl border border-border bg-card p-4">
                <h2 className="text-sm font-semibold">{t("rp.stepTargets")}</h2>
                <div className="flex flex-wrap gap-1.5">
                  {TARGET_PRESET_IDS.map((pid) => {
                    const p = presetById(pid)!;
                    const platform = platformOfPreset(p);
                    const on = targets.includes(pid);
                    return (
                      <button
                        key={pid}
                        aria-pressed={on}
                        onClick={() =>
                          setTargets((ts) => (on ? ts.filter((x) => x !== pid) : [...ts, pid]))
                        }
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
                          on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {platform && <PlatformIcon platform={platform} colored={on} />}
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
                    {t("rp.captions")}
                  </label>
                  {captions && (
                    <label className="flex items-center gap-2">
                      <span className="text-muted-foreground">{t("rp.captionStyle")}</span>
                      <select
                        value={styleId}
                        onChange={(e) => setStyleId(e.target.value)}
                        className="h-7 rounded border border-input bg-background px-1.5"
                      >
                        {SUBTITLE_PRESETS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex items-center gap-2" title={t("rp.followHint")}>
                    <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                    {t("rp.follow")}
                  </label>
                </div>
              </section>
            </>
          )}
        </section>
      )}

      {/* sticky generate bar */}
      {rows.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <p className="flex-1 truncate text-xs text-muted-foreground">
              {busy === "generate" && genStep
                ? `${t("rp.creating", { n: genStep.n, total: genStep.total })} · ${genStep.step}`
                : !canCreate && busy === null
                  ? t("rp.needSelection")
                  : ""}
            </p>
            <Button disabled={!canCreate} onClick={() => void generate()}>
              {busy === "generate" ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Scissors className="mr-1.5 size-4" />}
              {t("rp.createN", { count: selected.length })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

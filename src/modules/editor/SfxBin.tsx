import { FolderInput, Pause, Play, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import { addClip } from "@/lib/timeline-engine";
import { setDragPayload } from "@/lib/drag-payload";
import type { AssetSummary } from "@/lib/media-types";
import { cn } from "@/lib/utils";
import catalogJson from "../../../shared/sfx/catalog.json";

interface SfxSound {
  id: string;
  name: string;
  category: string;
  file: string;
  durationMs: number;
}
const CATALOG = catalogJson as {
  categories: { id: string; icon: string }[];
  sounds: SfxSound[];
};

/** Bundled OGG previews — Vite serves them in dev and packs them into dist. */
const SFX_URLS = import.meta.glob("../../../shared/sfx/files/*.ogg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const sfxUrl = (file: string) => SFX_URLS[`../../../shared/sfx/files/${file}`];

const fmtDur = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Bundled sound-effects library (CC0). Sounds are imported lazily — only
 * what the user drops or adds enters the media catalog as a regular audio
 * asset, so the media bin stays clean and export resolves the real file.
 */
export function SfxBin({ assets }: { assets: AssetSummary[] }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const mutate = useEditor((s) => s.mutate);
  const select = useEditor((s) => s.select);
  const qc = useQueryClient();

  const [cat, setCat] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const sounds = useMemo(
    () =>
      CATALOG.sounds.filter(
        (s) =>
          (cat === "all" || s.category === cat) &&
          (!query || s.name.toLowerCase().includes(query.toLowerCase())),
      ),
    [cat, query],
  );

  const imported = useMemo(
    () =>
      assets.filter(
        (a) =>
          a.kind === "audio" &&
          a.status !== "missing" &&
          (!query || a.name.toLowerCase().includes(query.toLowerCase())),
      ),
    [assets, query],
  );

  if (!doc) return null;

  const togglePlay = (id: string, src: string | undefined) => {
    const el = audioRef.current;
    if (!el || !src) return;
    if (playing === id) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = src;
    void el.play();
    setPlaying(id);
  };

  const placeClip = (a: AssetSummary, fallbackMs: number) => {
    let clipId = "";
    mutate((d) => {
      const r = addClip(d, {
        mediaRef: a.id,
        startMs: playheadMs,
        durationMs: a.durationMs ?? fallbackMs,
        sourceDurationMs: a.durationMs ?? null,
        trackKind: "audio",
      });
      clipId = r.clipId;
      if (!r.doc.mediaRefs.some((m) => m.assetId === a.id)) {
        r.doc.mediaRefs.push({ assetId: a.id, path: a.filePath, hash: null });
      }
      return r.doc;
    });
    select([clipId]);
    qc.invalidateQueries({ queryKey: ["assets"] });
    toast.success(t("editor.clipAdded"));
  };

  const addAt = (s: SfxSound) => {
    void api
      .importSfx([s.file])
      .then(([a]) => {
        if (a) placeClip(a, s.durationMs);
      })
      .catch(() => toast.error(t("editor.sfxImportFailed")));
  };

  const importFiles = async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Audio", extensions: ["mp3","wav","aac","m4a","flac","ogg","opus","wma"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length) return;
    const jobId = await api.importMedia(paths);
    await awaitJob(jobId);
    await qc.invalidateQueries({ queryKey: ["assets"] });
  };

  const row = (p: {
    key: string;
    id: string;
    name: string;
    sub: string;
    src: string | undefined;
    onDrag: (e: React.DragEvent) => void;
    onAdd: () => void;
  }) => (
    <div
      key={p.key}
      draggable
      onClick={() => togglePlay(p.id, p.src)}
      onDragStart={p.onDrag}
      onDragEnd={() => setDragPayload(null)}
      className={cn(
        "group relative flex cursor-pointer items-center gap-2 overflow-hidden rounded border bg-background/60 p-1.5 text-xs hover:bg-accent",
        playing === p.id
          ? "border-primary/50 bg-primary/10 hover:bg-primary/10"
          : "border-border",
      )}
    >
      {playing === p.id && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary/20">
          <div ref={barRef} className="h-full bg-primary transition-[width]" />
        </div>
      )}
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          playing === p.id
            ? "bg-primary text-primary-foreground"
            : "bg-primary/15 text-primary",
        )}
      >
        {playing === p.id ? (
          <Pause className="size-3" />
        ) : (
          <Play className="ml-0.5 size-3" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate">{p.name}</div>
        <div className="text-[10px] text-muted-foreground">{p.sub}</div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          p.onAdd();
        }}
        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
        title={t("editor.clipAdded")}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <audio
        ref={audioRef}
        onEnded={() => setPlaying(null)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (barRef.current && el.duration) {
            barRef.current.style.width = `${(el.currentTime / el.duration) * 100}%`;
          }
        }}
        className="hidden"
      />
      <div className="border-b border-border p-2">
        <div className="flex items-center gap-1.5">
          <div className="flex flex-1 items-center gap-1.5 rounded border border-border bg-background/60 px-2 py-1">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("editor.sfxSearch")}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            className="rounded p-1 hover:bg-accent"
            title={t("editor.sfxImport")}
            onClick={() => void importFiles()}
          >
            <FolderInput className="size-3.5" />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {["all", ...CATALOG.categories.map((c) => c.id)].map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                cat === c
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {t(`editor.sfxCat.${c}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {imported.length > 0 && (
          <div className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("editor.sfxImported")}
          </div>
        )}
        {imported.map((a) =>
          row({
            key: a.id,
            id: `a-${a.id}`,
            name: a.name,
            sub: fmtDur(a.durationMs ?? 0),
            src: convertFileSrc(a.filePath),
            onDrag: (e) => {
              e.dataTransfer.setData("application/x-creatora-asset", a.id);
              e.dataTransfer.setData("application/x-creatora-path", a.filePath);
              e.dataTransfer.setData(
                "application/x-creatora-duration",
                String(a.durationMs ?? 3000),
              );
              e.dataTransfer.effectAllowed = "copy";
              setDragPayload({
                assetId: a.id,
                filePath: a.filePath,
                durationMs: a.durationMs ?? 3000,
                kind: "audio",
              });
            },
            onAdd: () => placeClip(a, 3000),
          }),
        )}
        {imported.length > 0 && (
          <div className="px-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("editor.sfxLibrary")}
          </div>
        )}
        {sounds.map((s) =>
          row({
            key: s.id,
            id: s.id,
            name: s.name,
            sub: `${t(`editor.sfxCat.${s.category}`)} · ${fmtDur(s.durationMs)}`,
            src: sfxUrl(s.file),
            onDrag: (e) => {
              e.dataTransfer.setData("application/x-creatora-sfx", s.file);
              e.dataTransfer.setData(
                "application/x-creatora-duration",
                String(s.durationMs),
              );
              e.dataTransfer.effectAllowed = "copy";
              // dataTransfer isn't readable during dragover — stash for the
              // timeline's drop ghost + lane validation.
              setDragPayload({
                assetId: s.id,
                filePath: s.file,
                durationMs: s.durationMs,
                kind: "sfx",
                sfxFile: s.file,
              });
            },
            onAdd: () => addAt(s),
          }),
        )}
      </div>
    </div>
  );
}

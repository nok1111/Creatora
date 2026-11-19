import { Pause, Play, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import { addClip } from "@/lib/timeline-engine";
import { setDragPayload } from "@/lib/drag-payload";
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
export function SfxBin() {
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

  if (!doc) return null;

  const togglePlay = (s: SfxSound) => {
    const el = audioRef.current;
    const url = sfxUrl(s.file);
    if (!el || !url) return;
    if (playing === s.id) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = url;
    void el.play();
    setPlaying(s.id);
  };

  const addAt = (s: SfxSound) => {
    void api
      .importSfx([s.file])
      .then(([a]) => {
        if (!a) return;
        let clipId = "";
        mutate((d) => {
          const r = addClip(d, {
            mediaRef: a.id,
            startMs: playheadMs,
            durationMs: a.durationMs ?? s.durationMs,
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
      })
      .catch(() => toast.error(t("editor.sfxImportFailed")));
  };

  return (
    <div className="flex h-full flex-col">
      <audio
        ref={audioRef}
        onEnded={() => setPlaying(null)}
        className="hidden"
      />
      <div className="border-b border-border p-2">
        <div className="flex items-center gap-1.5 rounded border border-border bg-background/60 px-2 py-1">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("editor.sfxSearch")}
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
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
        {sounds.map((s) => (
          <div
            key={s.id}
            draggable
            onDragStart={(e) => {
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
            }}
            onDragEnd={() => setDragPayload(null)}
            className="group flex cursor-grab items-center gap-2 rounded border border-border bg-background/60 p-1.5 text-xs hover:bg-accent"
          >
            <button
              onClick={() => togglePlay(s)}
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary hover:bg-primary/25"
              title={s.name}
            >
              {playing === s.id ? (
                <Pause className="size-3" />
              ) : (
                <Play className="ml-0.5 size-3" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate">{s.name}</div>
              <div className="text-[10px] text-muted-foreground">
                {t(`editor.sfxCat.${s.category}`)} · {fmtDur(s.durationMs)}
              </div>
            </div>
            <button
              onClick={() => addAt(s)}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              title={t("editor.clipAdded")}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

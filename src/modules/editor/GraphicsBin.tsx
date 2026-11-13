import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Download, Upload, Palette, Type, Square, Sparkles } from "lucide-react";
import { api } from "@/lib/ipc";
import type { Template } from "@/lib/ipc";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  addClip,
  addGeneratedClip,
  applyBrandToBoundClips,
  setDocBrandKit,
} from "@/lib/timeline-engine";
import { DEFAULT_TEXT_STYLE } from "@/lib/project-types";
import type { BrandKit, BrandLogo } from "@/lib/project-types";
import { awaitJob } from "@/services/jobs";

const TEMPLATE_CATEGORIES = ["title", "lowerThird", "callout", "badge", "intro", "outro", "shape", "brand"] as const;


/** Graphics bin (ADR-027): quick-add elements, reusable clip templates,
    brand kits — everything local-file based, no external services. */
export function GraphicsBin() {
  const doc = useProject((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const mutate = useEditor((s) => s.mutate);
  const select = useEditor((s) => s.select);
  const qc = useQueryClient();
  const [brandOpen, setBrandOpen] = useState(false);
  const [newKitName, setNewKitName] = useState("");

  const templatesQ = useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });
  const kitsQ = useQuery({ queryKey: ["brandkits"], queryFn: api.listBrandKits });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["templates"] });
    void qc.invalidateQueries({ queryKey: ["brandkits"] });
  };

  if (!doc) return null;

  const insert = (fields: Parameters<typeof addGeneratedClip>[2], kind: "text" | "graphics" = "text") => {
    let id = "";
    mutate((d) => {
      const r = addGeneratedClip(d, kind, fields);
      id = r.clipId;
      return r.doc;
    });
    select([id]);
  };

  const addTitle = () =>
    insert({
      startMs: playheadMs,
      durationMs: 3000,
      text: "Title",
      textStyle: { ...DEFAULT_TEXT_STYLE, fontSizePx: Math.round(doc.canvas.height * 0.09) },
    });

  const addLowerThird = () =>
    insert(
      {
        startMs: playheadMs,
        durationMs: 4000,
        text: "Name · Role",
        textStyle: {
          ...DEFAULT_TEXT_STYLE,
          fontSizePx: Math.round(doc.canvas.height * 0.04),
          alignV: "bottom",
          backgroundColor: "#000000AA",
          backgroundPadPx: 14,
        },
        transform: { y: -doc.canvas.height * 0.06 },
      },
      "graphics",
    );

  const addShape = () =>
    insert(
      {
        startMs: playheadMs,
        durationMs: 3000,
        shape: {
          kind: "rect",
          fill: doc.brandKit?.colors[0] ?? "#38BDF8",
          outlineColor: null,
          outlineWidth: 0,
          widthPx: Math.round(doc.canvas.width * 0.2),
          heightPx: Math.round(doc.canvas.height * 0.05),
        },
        transform: { y: doc.canvas.height * 0.3 },
      },
      "graphics",
    );

  /** Shape + text on ONE clip — the layer renders both (ADR-027). */
  const addBadge = () =>
    insert(
      {
        startMs: playheadMs,
        durationMs: 4000,
        text: "NEW",
        textStyle: {
          ...DEFAULT_TEXT_STYLE,
          fontSizePx: Math.round(doc.canvas.height * 0.045),
        },
        shape: {
          kind: "rect",
          fill: doc.brandKit?.colors[0] ?? "#EF4444",
          outlineColor: null,
          outlineWidth: 0,
          widthPx: Math.round(doc.canvas.width * 0.14),
          heightPx: Math.round(doc.canvas.height * 0.09),
        },
      },
      "graphics",
    );

  const addCallout = () =>
    insert(
      {
        startMs: playheadMs,
        durationMs: 4000,
        text: "Watch this →",
        textStyle: {
          ...DEFAULT_TEXT_STYLE,
          fontSizePx: Math.round(doc.canvas.height * 0.038),
          alignH: "left",
          backgroundColor: "#000000AA",
          backgroundPadPx: 10,
        },
        transform: { x: -doc.canvas.width * 0.22, y: -doc.canvas.height * 0.25 },
      },
      "graphics",
    );

  const applyTemplate = (tpl: Template) => {
    // Replace text without losing the design (style/anim/shape intact).
    const text =
      tpl.clip.text != null
        ? window.prompt("Text", tpl.clip.text) ?? tpl.clip.text
        : undefined;
    let id = "";
    mutate((d) => {
      const r = addGeneratedClip(d, "graphics", {
        startMs: playheadMs,
        durationMs: tpl.clip.durationMs,
        text,
        textStyle: tpl.clip.textStyle ?? undefined,
        shape: tpl.clip.shape ?? undefined,
        transform: tpl.clip.transform,
      });
      id = r.clipId;
      const c = r.doc.timeline.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!;
      c.textFx = tpl.clip.textFx ?? null;
      c.keyframes = { ...tpl.clip.keyframes };
      c.effects = tpl.clip.effects.map((e) => ({ ...e, params: { ...e.params } }));
      return r.doc;
    });
    select([id]);
  };

  const duplicateTemplate = async (tpl: Template) => {
    await api.saveTemplate({
      ...tpl,
      id: crypto.randomUUID(),
      name: `${tpl.name} copy`,
      clip: JSON.parse(JSON.stringify(tpl.clip)),
    });
    invalidate();
  };

  /** Import a brand logo file into the media catalog and drop it on an
      image track — real insert, not a pointer to the Library. */
  const insertLogo = async (l: BrandLogo) => {
    const jobId = await api.importMedia([l.path]);
    await awaitJob(jobId);
    const assets = await api.listAssets();
    const a = assets.find((x) => x.filePath === l.path);
    if (!a) {
      window.alert(`Could not import logo: ${l.path}`);
      return;
    }
    let id = "";
    mutate((d) => {
      const r = addClip(d, {
        mediaRef: a.id,
        startMs: playheadMs,
        durationMs: 3000,
        trackKind: "image",
      });
      id = r.clipId;
      if (!r.doc.mediaRefs.some((m) => m.assetId === a.id)) {
        r.doc.mediaRefs.push({ assetId: a.id, path: a.filePath, hash: null });
      }
      return r.doc;
    });
    select([id]);
  };

  const saveSelectionAsTemplate = async () => {
    const sel = useEditor.getState().selection[0];
    const clip = doc.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === sel);
    if (!clip) return;
    const name = window.prompt("Template name", clip.text ?? "Graphic") ?? "";
    if (!name.trim()) return;
    const cat =
      window.prompt(
        `Category (${TEMPLATE_CATEGORIES.join(", ")})`,
        clip.shape ? "shape" : "title",
      ) ?? "";
    await api.saveTemplate({
      id: crypto.randomUUID(),
      name: name.trim(),
      category: cat.trim() || (clip.shape ? "shape" : "title"),
      clip: JSON.parse(JSON.stringify(clip)),
      brandKitId: doc.brandKitId ?? undefined,
    });
    invalidate();
  };

  const groups = new Map<string, Template[]>();
  for (const tpl of templatesQ.data ?? []) {
    const g = groups.get(tpl.category) ?? [];
    g.push(tpl);
    groups.set(tpl.category, g);
  }

  const createKit = async () => {
    if (!newKitName.trim()) return;
    const kit: BrandKit = {
      id: crypto.randomUUID(),
      name: newKitName.trim(),
      colors: ["#38BDF8", "#FFFFFF", "#0F172A"],
      fonts: [],
      logos: [],
      titleStyle: { ...DEFAULT_TEXT_STYLE, color: "#38BDF8" },
    };
    await api.saveBrandKit(kit);
    setNewKitName("");
    invalidate();
    mutate((d) => setDocBrandKit(d, kit));
  };

  const activeKit = doc.brandKit;

  return (
    <div className="flex h-full flex-col overflow-y-auto border-r border-border bg-card text-xs">
      {/* quick add */}
      <div className="space-y-1 border-b border-border p-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Add element</div>
        <div className="grid grid-cols-3 gap-1">
          <button className="flex flex-col items-center gap-0.5 rounded border border-border p-1.5 hover:bg-accent" onClick={addTitle}>
            <Type className="size-4" /> <span className="text-[9px]">Title</span>
          </button>
          <button className="flex flex-col items-center gap-0.5 rounded border border-border p-1.5 hover:bg-accent" onClick={addLowerThird}>
            <Sparkles className="size-4" /> <span className="text-[9px]">Lower 3rd</span>
          </button>
          <button className="flex flex-col items-center gap-0.5 rounded border border-border p-1.5 hover:bg-accent" onClick={addShape}>
            <Square className="size-4" /> <span className="text-[9px]">Shape</span>
          </button>
          <button className="flex flex-col items-center gap-0.5 rounded border border-border p-1.5 hover:bg-accent" onClick={addBadge}>
            <Sparkles className="size-4" /> <span className="text-[9px]">Badge</span>
          </button>
          <button className="flex flex-col items-center gap-0.5 rounded border border-border p-1.5 hover:bg-accent" onClick={addCallout}>
            <Type className="size-4" /> <span className="text-[9px]">Callout</span>
          </button>
          <button
            className="flex flex-col items-center gap-0.5 rounded border border-border p-1.5 hover:bg-accent"
            title="Heading — large centered text"
            onClick={() =>
              insert({
                startMs: playheadMs,
                durationMs: 3000,
                text: "Heading",
                textStyle: {
                  ...DEFAULT_TEXT_STYLE,
                  fontSizePx: Math.round(doc.canvas.height * 0.07),
                  alignV: "top",
                  shadowColor: "#000000CC",
                  shadowX: 4,
                  shadowY: 4,
                },
                transform: { y: -doc.canvas.height * 0.35 },
              })
            }
          >
            <Type className="size-4" /> <span className="text-[9px]">Heading</span>
          </button>
        </div>
      </div>

      {/* templates */}
      <div className="space-y-1 border-b border-border p-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Templates</span>
          <button
            className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
            title="Save selected element as template"
            disabled={useEditor.getState().selection.length !== 1}
            onClick={() => void saveSelectionAsTemplate()}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {[...groups.entries()].map(([cat, tpls]) => (
          <div key={cat}>
            <div className="text-[9px] uppercase text-muted-foreground/70">{cat}</div>
            {tpls.map((tpl) => (
              <div key={tpl.id} className="group relative flex items-center justify-between rounded px-1 py-0.5 hover:bg-accent">
                <button
                  className="truncate text-left"
                  title={tpl.clip.text ?? tpl.clip.shape?.kind ?? "template"}
                  onClick={() => applyTemplate(tpl)}
                >
                  {tpl.name}
                </button>
                {/* hover preview — same render model as the canvas */}
                <div className="pointer-events-none absolute left-full top-0 z-20 ml-1 hidden h-[54px] w-[96px] overflow-hidden rounded border border-border bg-black group-hover:block">
                  <div className="relative h-full w-full">
                    {tpl.clip.shape && (
                      <div
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                        style={{
                          width: `${Math.min(90, (tpl.clip.shape.widthPx / doc.canvas.width) * 100)}%`,
                          height: `${Math.min(90, (tpl.clip.shape.heightPx / doc.canvas.height) * 100)}%`,
                          background: tpl.clip.shape.fill,
                        }}
                      />
                    )}
                    {tpl.clip.text && (
                      <div
                        className="absolute inset-0 flex items-center justify-center overflow-hidden px-1 text-center"
                        style={{
                          color: tpl.clip.textStyle?.color ?? "#fff",
                          fontSize: `${Math.max(6, ((tpl.clip.textStyle?.fontSizePx ?? 48) / doc.canvas.height) * 54)}px`,
                          background: tpl.clip.textStyle?.backgroundColor ?? undefined,
                        }}
                      >
                        {tpl.clip.text}
                      </div>
                    )}
                  </div>
                </div>
                <span className="invisible flex gap-0.5 group-hover:visible">
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    title="Duplicate template"
                    onClick={() => void duplicateTemplate(tpl)}
                  >
                    <Plus className="size-3" />
                  </button>
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    onClick={async () => {
                      await api.deleteTemplate(tpl.id);
                      invalidate();
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
        {(templatesQ.data ?? []).length === 0 && (
          <div className="text-[10px] text-muted-foreground">
            Select an element → + to save a reusable template
          </div>
        )}
      </div>

      {/* brand kit */}
      <div className="space-y-1 p-2">
        <button
          className="flex w-full items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground"
          onClick={() => setBrandOpen(!brandOpen)}
        >
          <span className="flex items-center gap-1">
            <Palette className="size-3.5" /> Brand kit {activeKit ? `· ${activeKit.name}` : ""}
          </span>
          <span>{brandOpen ? "−" : "+"}</span>
        </button>
        {brandOpen && (
          <div className="space-y-1.5">
            {(kitsQ.data ?? []).map((k) => (
              <div key={k.id} className="flex items-center justify-between rounded px-1 py-0.5 hover:bg-accent">
                <button
                  className={`truncate text-left ${doc.brandKitId === k.id ? "text-accent-foreground" : ""}`}
                  onClick={() => mutate((d) => setDocBrandKit(d, doc.brandKitId === k.id ? null : k))}
                  title="Set active (embeds snapshot into project)"
                >
                  {k.name}
                </button>
                <span className="flex gap-0.5">
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    title="Export kit JSON"
                    onClick={async () => {
                      const p = window.prompt("Export to path", `C:\\\\${k.name}.brand.json`);
                      if (p) await api.exportBrandKit(k.id, p);
                    }}
                  >
                    <Download className="size-3" />
                  </button>
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    onClick={async () => {
                      await api.deleteBrandKit(k.id);
                      invalidate();
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              </div>
            ))}
            <div className="flex gap-1">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5"
                placeholder="New brand name"
                value={newKitName}
                onChange={(e) => setNewKitName(e.target.value)}
              />
              <button className="rounded border border-border px-1 hover:bg-accent" onClick={() => void createKit()}>
                <Plus className="size-3.5" />
              </button>
              <button
                className="rounded border border-border px-1 hover:bg-accent"
                title="Import kit JSON"
                onClick={async () => {
                  const p = window.prompt("Import kit JSON path");
                  if (p) {
                    await api.importBrandKit(p);
                    invalidate();
                  }
                }}
              >
                <Upload className="size-3.5" />
              </button>
            </div>
            {activeKit && (
              <div className="space-y-1 rounded border border-border p-1">
                <div className="flex gap-0.5">
                  {activeKit.colors.map((c, i) => (
                    <span
                      key={i}
                      className="size-4 rounded-sm border border-border"
                      style={{ background: c }}
                      title={c}
                    />
                  ))}
                </div>
                {activeKit.logos.map((l, i) => (
                  <button
                    key={i}
                    className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] hover:bg-accent"
                    title={`Insert logo at playhead: ${l.path}`}
                    onClick={() => void insertLogo(l)}
                  >
                    ◇ {l.name}
                  </button>
                ))}
                <button
                  className="w-full rounded border border-border px-1 py-0.5 text-[10px] hover:bg-accent"
                  title="Re-apply snapshot to every brand-bound element"
                  onClick={() => mutate((d) => applyBrandToBoundClips(d))}
                >
                  Apply brand to bound elements
                </button>
                <EditKitInline kit={activeKit} onSaved={invalidate} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EditKitInline({ kit, onSaved }: { kit: BrandKit; onSaved: () => void }) {
  const mutate = useEditor((s) => s.mutate);
  const [edit, setEdit] = useState(false);
  const [colors, setColors] = useState(kit.colors.join(", "));
  const [fonts, setFonts] = useState(kit.fonts.map((f) => `${f.name}|${f.path}`).join("\n"));
  const [logos, setLogos] = useState(kit.logos.map((l) => `${l.name}|${l.path}|${l.role ?? ""}`).join("\n"));

  if (!edit) {
    return (
      <button className="w-full rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent" onClick={() => setEdit(true)}>
        Edit kit…
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <textarea
        className="h-8 w-full rounded border border-border bg-background p-1 font-mono text-[9px]"
        value={colors}
        onChange={(e) => setColors(e.target.value)}
        placeholder="#RRGGBB, #RRGGBB, …"
      />
      <textarea
        className="h-12 w-full rounded border border-border bg-background p-1 font-mono text-[9px]"
        value={fonts}
        onChange={(e) => setFonts(e.target.value)}
        placeholder={"Name|C:\\path\\font.ttf"}
      />
      <textarea
        className="h-12 w-full rounded border border-border bg-background p-1 font-mono text-[9px]"
        value={logos}
        onChange={(e) => setLogos(e.target.value)}
        placeholder={"Name|C:\\path\\logo.png|primary"}
      />
      <button
        className="w-full rounded border border-cyan-600 px-1 py-0.5 text-[10px] hover:bg-cyan-600/20"
        onClick={async () => {
          const k2: BrandKit = {
            ...kit,
            colors: colors.split(",").map((c) => c.trim()).filter(Boolean),
            fonts: fonts.split("\n").map((l) => l.split("|")).filter((a) => a.length >= 2).map(([name, path]) => ({ name: name.trim(), path: path.trim() })),
            logos: logos.split("\n").map((l) => l.split("|")).filter((a) => a.length >= 2).map(([name, path, role]) => ({ name: name.trim(), path: path.trim(), role: role?.trim() ?? "" })),
          };
          await api.saveBrandKit(k2);
          // refresh embedded snapshot so bound elements see new values
          mutate((d) => setDocBrandKit(d, k2));
          setEdit(false);
          onSaved();
        }}
      >
        Save kit
      </button>
    </div>
  );
}

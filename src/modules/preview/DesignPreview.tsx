/**
 * Phase 10.5B — isolated visual proposal prototype.
 * Route: /design-preview (not in nav; no production wiring).
 * Static mockups of the proposed Creative Pop module redesigns so the
 * direction can be reviewed before any real implementation.
 */
import { useState } from "react";
import {
  Film, Smartphone, Square, Youtube, Mic2, Sparkles, Type, Palette,
  Scissors, Music4, Subtitles, Image, Wand2, Volume2, Ear, Guitar,
  Check, Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SEC = "mb-10";
const H2 = "text-lg font-semibold mb-1";
const SUB = "text-xs text-muted-foreground mb-4";

function Tag({ c, t }: { c: string; t: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", c)}>{t}</span>
  );
}

/* ---------- Multi-Format platform cards ---------- */
function FormatCard({
  icon, name, ratio, w, h, active, onClick, hint,
}: {
  icon: React.ReactNode; name: string; ratio: string; w: number; h: number;
  active?: boolean; onClick?: () => void; hint: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-36 flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all",
        active
          ? "border-accent bg-accent/10 shadow-[0_0_0_3px_hsl(var(--accent)/0.15)]"
          : "border-border bg-card hover:border-muted-foreground/40",
      )}
    >
      <div
        className="flex items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground"
        style={{ width: w, height: h }}
      >
        {icon}
      </div>
      <div className="text-sm font-medium">{name}</div>
      <div className="text-[10px] text-muted-foreground">{ratio}</div>
      <div className="text-[10px] text-muted-foreground/70">{hint}</div>
      {active && <Tag c="bg-accent/20 text-accent" t="Active" />}
    </button>
  );
}

/* ---------- Subtitle preset cards ---------- */
function SubPreset({ name, preview, style, active, onClick }: {
  name: string; preview: string; style: React.CSSProperties; active?: boolean; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-44 flex-col overflow-hidden rounded-xl border-2 text-left transition-all",
        active ? "border-accent shadow-[0_0_0_3px_hsl(var(--accent)/0.15)]" : "border-border hover:border-muted-foreground/40",
      )}
    >
      <div className="flex h-20 items-center justify-center bg-[#0d0d12] px-3">
        <span className="text-center text-sm" style={style}>{preview}</span>
      </div>
      <div className="flex items-center justify-between bg-card px-3 py-2">
        <span className="text-xs font-medium">{name}</span>
        {active && <Check className="size-3.5 text-accent" />}
      </div>
    </button>
  );
}

/* ---------- Audio preset cards ---------- */
function AudioPreset({ icon, name, desc, tone, active, onClick }: {
  icon: React.ReactNode; name: string; desc: string; tone: string; active?: boolean; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-52 items-center gap-3 rounded-xl border-2 p-3 text-left transition-all",
        active ? "border-success bg-success/10" : "border-border bg-card hover:border-muted-foreground/40",
      )}
    >
      <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", tone)}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{name}</div>
        <div className="truncate text-[10px] text-muted-foreground">{desc}</div>
      </div>
    </button>
  );
}

export function DesignPreview() {
  const [fmt, setFmt] = useState("16:9");
  const [sub, setSub] = useState("pop");
  const [aud, setAud] = useState("voice");

  return (
    <div className="h-full overflow-y-auto bg-background p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center gap-3">
          <Sparkles className="size-6 text-accent" />
          <div>
            <h1 className="text-2xl font-bold">Creative Pop — design proposal</h1>
            <p className="text-sm text-muted-foreground">
              Interactive mockups · isolated preview route · nothing here is wired to production data
            </p>
          </div>
          <Tag c="bg-warning/20 text-warning" t="Preview only" />
        </div>

        {/* Editor */}
        <section className={SEC}>
          <h2 className={H2}>1 · Editor — approachable chrome</h2>
          <p className={SUB}>Preview stays dominant; common actions become labeled buttons; advanced controls move to collapsible groups.</p>
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <span className="text-sm font-medium">Beach vlog final</span>
              <div className="mx-2 h-4 w-px bg-border" />
              {[Scissors, Type, Music4, Subtitles, Image].map((I, i) => (
                <button key={i} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                  <I className="size-3.5" /> {["Trim", "Text", "Music", "Captions", "Overlay"][i]}
                </button>
              ))}
              <div className="flex-1" />
              <button className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground">Export</button>
            </div>
            <div className="flex">
              <div className="flex h-56 flex-1 items-center justify-center bg-[#0d0d12] text-muted-foreground">
                <Film className="mr-2 size-8 opacity-40" /> preview
              </div>
              <div className="w-48 border-l border-border p-3 text-[10px] text-muted-foreground">
                <div className="mb-1 font-medium text-foreground">Inspector</div>
                collapsible groups · plain language
              </div>
            </div>
            <div className="h-16 border-t border-border bg-secondary/40 p-2 text-[10px] text-muted-foreground">
              timeline — unchanged (pro features preserved)
            </div>
          </div>
        </section>

        {/* Multi-format */}
        <section className={SEC}>
          <h2 className={H2}>2 · Multi-Format — visual platform cards</h2>
          <p className={SUB}>Click a card → a version is created. Aspect-ratio shape is the interface, not a table row.</p>
          <div className="flex flex-wrap gap-3">
            <FormatCard icon={<Youtube className="size-5" />} name="YouTube" ratio="16:9 · 1920×1080" w={72} h={40} hint="Full video" active={fmt === "16:9"} onClick={() => setFmt("16:9")} />
            <FormatCard icon={<Smartphone className="size-5" />} name="Reels / Shorts" ratio="9:16 · 1080×1920" w={32} h={56} hint="Smart reframe" active={fmt === "9:16"} onClick={() => setFmt("9:16")} />
            <FormatCard icon={<Square className="size-5" />} name="Feed" ratio="1:1 · 1080×1080" w={44} h={44} hint="Instagram / FB" active={fmt === "1:1"} onClick={() => setFmt("1:1")} />
            <FormatCard icon={<Film className="size-5" />} name="Custom" ratio="any size" w={44} h={44} hint="Manual canvas" active={fmt === "x"} onClick={() => setFmt("x")} />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Selected: <b className="text-accent">{fmt}</b> — a "what changes" strip (crop preview + duration note) appears before export.
          </p>
        </section>

        {/* Subtitles */}
        <section className={SEC}>
          <h2 className={H2}>3 · Subtitle Studio — preset cards with real previews</h2>
          <p className={SUB}>Styles rendered on video-dark thumbnails; click applies the existing SubtitleStyle model.</p>
          <div className="flex flex-wrap gap-3">
            <SubPreset name="Pop" preview="BIG WORD energy" active={sub === "pop"} onClick={() => setSub("pop")}
              style={{ color: "#FFD477", fontWeight: 800, textShadow: "2px 2px 0 #000" }} />
            <SubPreset name="Karaoke" preview="word by word glow" active={sub === "karaoke"} onClick={() => setSub("karaoke")}
              style={{ color: "#B8F36B", fontWeight: 600 }} />
            <SubPreset name="Clean" preview="simple and readable" active={sub === "clean"} onClick={() => setSub("clean")}
              style={{ color: "#F4F0E8", fontWeight: 400 }} />
            <SubPreset name="Outline" preview="streamer outline" active={sub === "outline"} onClick={() => setSub("outline")}
              style={{ color: "#FF795E", fontWeight: 700, WebkitTextStroke: "1px #17171D" }} />
          </div>
        </section>

        {/* Audio */}
        <section className={SEC}>
          <h2 className={H2}>4 · Audio Studio — one-click friendly presets</h2>
          <p className={SUB}>Plain-language goals that map to existing effect chains; mixer stays one click away.</p>
          <div className="flex flex-wrap gap-3">
            <AudioPreset icon={<Mic2 className="size-5 text-accent" />} name="Clear Voice" desc="Compress + presence EQ" tone="bg-accent/15" active={aud === "voice"} onClick={() => setAud("voice")} />
            <AudioPreset icon={<Ear className="size-5 text-success" />} name="Reduce Noise" desc="Gate + low-cut filter" tone="bg-success/15" active={aud === "noise"} onClick={() => setAud("noise")} />
            <AudioPreset icon={<Wand2 className="size-5 text-accent" />} name="Enhance Voice" desc="De-ess + warmth" tone="bg-accent/15" active={aud === "enhance"} onClick={() => setAud("enhance")} />
            <AudioPreset icon={<Guitar className="size-5 text-warning" />} name="Balance Music" desc="Auto-duck under voice" tone="bg-warning/15" active={aud === "music"} onClick={() => setAud("music")} />
            <AudioPreset icon={<Volume2 className="size-5 text-muted-foreground" />} name="Louder" desc="Normalize to −14 LUFS" tone="bg-secondary" active={aud === "loud"} onClick={() => setAud("loud")} />
          </div>
        </section>

        {/* Brand kit */}
        <section className={SEC}>
          <h2 className={H2}>5 · Brand Kit — visual identity board</h2>
          <p className={SUB}>Colors/fonts/logos as a moodboard you can click to apply.</p>
          <div className="grid max-w-lg grid-cols-3 gap-3 rounded-xl border border-border bg-card p-4">
            {["#FF795E", "#B8F36B", "#B99AFF", "#FFD477", "#F4F0E8", "#17171D"].map((c) => (
              <div key={c} className="group cursor-pointer">
                <div className="h-12 rounded-lg border border-border/50 transition-transform group-hover:scale-105" style={{ background: c }} />
                <div className="mt-1 text-center font-mono text-[10px] text-muted-foreground">{c}</div>
              </div>
            ))}
            <div className="col-span-3 flex items-center gap-3 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              <Type className="size-4" /> Inter · Bold for titles — drag onto a text clip to apply
              <Palette className="ml-auto size-4" />
            </div>
          </div>
        </section>

        {/* Canvas manipulation gap */}
        <section className={SEC}>
          <h2 className={H2}>6 · Canvas direct manipulation — audited</h2>
          <div className="max-w-2xl rounded-xl border border-border bg-card p-4 text-xs leading-relaxed">
            <div className="mb-2 flex items-center gap-2"><Check className="size-4 text-success" /><b>Already works:</b> drag to move text/shape/graphics clips on the preview — writes transform.x/y, version-override aware.</div>
            <div className="space-y-1 text-muted-foreground">
              <div className="flex gap-2"><Lock className="size-3.5 mt-0.5 text-warning" /> Selection outline + handles on the canvas element</div>
              <div className="flex gap-2"><Lock className="size-3.5 mt-0.5 text-warning" /> Resize via corner handles (transform.scale)</div>
              <div className="flex gap-2"><Lock className="size-3.5 mt-0.5 text-warning" /> Rotate handle (transform.rotationDeg)</div>
              <div className="flex gap-2"><Lock className="size-3.5 mt-0.5 text-warning" /> Double-click to edit text inline</div>
              <div className="flex gap-2"><Lock className="size-3.5 mt-0.5 text-warning" /> Center/edge snap guides while dragging</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

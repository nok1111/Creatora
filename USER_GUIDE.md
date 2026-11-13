# USER_GUIDE.md — Creatora

> User-facing guide. Early draft — sections fill in as features land.

## What is Creatora?

Creatora is an all-in-one Creator Studio for Windows: edit video, adapt it for every platform, subtitle it, design thumbnails, organize your brand and media, and publish — from one app. One-time purchase, works offline, no watermarks, no export limits.

## Getting started

*(Fills in during Phase 2)* — Create a project → pick resolution/frame rate → import media → edit → export.

## Workspaces

| Module | What it does |
|---|---|
| Home | Recent projects, templates, imports |
| Library | All your media, organized: collections, tags, search |
| Editor | Timeline video editing |
| Formats | One project → YouTube, Shorts, TikTok, Reels, square |
| Subtitles | Auto-transcribe, style, burn-in or export SRT/VTT |
| Audio | Mix, clean up, voice-over, waveforms, ducking, loudness |
| Graphics | Thumbnails and social graphics |
| Brand | Logos, colors, fonts, reusable presets |
| Social | Connect YouTube/TikTok/Instagram/Facebook |
| Planner | Calendar for drafts, scheduled and published posts |
| Analytics | Performance across platforms |
| Export | Render queue, presets, batch export |
| Settings | Appearance, language (EN/ES), storage, hardware |

## The Editor (Phase 3 slice)

Open a project, then:

1. **Import media first** in the Library — the editor's *Project media* bin on the left shows every imported video/audio/image.
2. **Add clips** by dragging an asset onto a track lane, or hover an asset and click **+** to drop it at the playhead.
3. **Preview** shows the canvas composition; video clips carry their own audio. Space or the round button plays/pauses.
4. **Edit non-destructively**: drag a clip to move it, drag its left/right edges to trim, press **S** (or the scissors) to split at the playhead, **Delete** to remove. Edits snap to frames and to the playhead/clip edges.
5. **Undo/redo**: Ctrl+Z / Ctrl+Y (full document undo, one entry per gesture).
6. **Save**: Ctrl+S or the disk icon. Autosave + crash recovery keep working in the background.
7. **Export**: the Export button asks for an `.mp4` path, saves the project, and renders via FFmpeg with a live progress bar and cancellable job. The output reflects the timeline exactly — trims, ordering, scale/position and audio timing included.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Space | Play / pause |
| S | Split selected clip(s) at playhead |
| Delete / Backspace | Remove selected clip(s) |
| ← / → | Step playhead one frame |
| Ctrl+S | Save project |
| Ctrl+Z / Ctrl+Y | Undo / redo |

*(Configurable bindings land in a later phase.)*

## Audio Studio

- **Waveforms** appear on audio clips automatically (generated in the
  background, cached on disk; they refine as you zoom).
- **Track header**: speaker = mute, **S** = solo, slider = track gain.
- **Clip inspector → Audio**: volume, speed, **pan** (−1 left … +1 right),
  **fade in/out** (ms).
- **Audio fx** (add-effect dropdown, entries marked `[audio]`): high-pass,
  low-pass, 3-band EQ, denoise, compressor, limiter, de-esser, noise gate.
  Preview applies the ones WebAudio can express; all apply on export.
- **Measure / Normalize →**: reads real EBU R128 loudness (LUFS, true
  peak, LRA) and applies the suggested gain to clip volume — undoable,
  never clipping (adds a limiter when needed). LUFS presets are
  *orientative*, not platform requirements.
- **Silence detect** lists silent regions for YOUR review — "Apply cut
  proposal" splits the clip keeping the speech (with padding). Fully
  undoable; nothing is removed until you apply it.
- **Auto-duck**: add a rule (source track → target track) — e.g. voice →
  music. Music ducks while voice is active and releases after, with
  adjustable threshold/reduction/attack/release/hold.

## Text & Graphics Studio

- **Add elements** (left panel → Graphics tab): Title, Lower third, Shape.
  Elements land as clips on text/graphics tracks at the playhead — move,
  trim, duplicate, keyframe them like any clip.
- **Drag on the canvas** to position. With a Format version active, the
  drag writes a per-version override — the base and other versions are
  untouched.
- **Inspector → Text**: content, font size, color, alignment, outline,
  background box, **shadow** (color + X/Y), **line spacing**. All changes
  export exactly as previewed.
- **Inspector → Graphics**: hide (per-clip, or per-version when a version
  is active), align-to-canvas buttons, shape fill/outline/size,
  copy/paste style between elements.
- **Animation presets**: entrances, exits, emphasis, transitions, loops —
  fade, slide, scale/pop, rotate, shake, pulse, float, typewriter,
  wipe, blur reveal/dissolve. Configure duration, direction, intensity,
  easing. Everything exports — no preview-only animations.
- **Shapes**: rectangles and lines (fill, outline, px size). Ellipses are
  not supported (documented engine limitation, not a bug).
- **Templates**: select an element → "+" in the Templates list saves it
  (with category). Click a template to insert it — you're asked for the
  replacement text first; design and animation are preserved. Templates
  live app-side and apply to every project; import/export as `.json`.
- **Brand Kit**: create kits (colors, fonts, logos, title style) in the
  Graphics tab; pick the active kit to embed a snapshot in the project.
  Bind a clip's color/font to kit slots in the Inspector — "Apply brand
  to bound elements" re-syncs them after a kit edit. Unbinding keeps the
  current values. Logos insert at playhead via one click (the file is
  imported to the Library automatically).
- **Multi-format**: position, scale, text, visibility and animation can
  diverge per version via overrides. The "re-sync" button (Inspector →
  Graphics, shown when a clip has version overrides) drops them and
  returns the element to the shared base.

## Where is my data?

- Projects: `.creatora` files wherever you saved them (default: `Documents\Creatora\Projects`).
- App data (library index, settings, accounts): `%APPDATA%\Creatora\`.
- Your videos are never uploaded without your explicit action.

## Troubleshooting

- **Missing media**: Library flags moved/deleted files; use Relink.
- **Crash recovery**: autosaves restore on next launch.
- **Logs**: `%APPDATA%\Creatora\logs\` — attach when reporting issues.

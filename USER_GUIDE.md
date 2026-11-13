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

## Social Studio

- **Posts**: create a post from any project, pick one or more
  platforms (YouTube, TikTok, Instagram, Facebook) and, per platform,
  which format version to use. Duplicate, search and filter by status.
- **Captions**: each platform gets its own title/description/hashtags
  without touching the project. Templates and hashtag history are
  saved locally; counters show per-platform limits.
- **Validation**: run the check before exporting — it flags wrong
  aspect ratios (with a link to Multi-Format Studio), missing audio or
  thumbnails, empty titles, duplicate hashtags and more, classified as
  Error / Warning / Recommendation.
- **Export**: "Export for target" renders the chosen version with the
  existing engine and links the file to the post — an export does NOT
  mark anything as published.
- **Calendar**: month/week/list views, drag to reschedule. Scheduling
  is local; a target auto-publishes only if you enabled Auto-publish
  AND a connected account AND the export exists. Otherwise you get a
  reminder when it's due.
- **Accounts**: connect via OAuth (system browser). You configure your
  own developer-app credentials — nothing is embedded. Tokens live in
  Windows Credential Manager; disconnecting deletes them. Instagram
  requires a Business/Creator account and a publicly reachable video
  URL; TikTok direct-publish needs an approved app.

## Where is my data?

- Projects: `.creatora` files wherever you saved them (default: `Documents\Creatora\Projects`).
- App data (library index, settings, accounts): `%APPDATA%\Creatora\`.
- Your videos are never uploaded without your explicit action.

## Troubleshooting

- **Missing media**: Library flags moved/deleted files; use Relink.
- **Crash recovery**: autosaves restore on next launch.
- **Logs**: `%APPDATA%\Creatora\logs\` — attach when reporting issues.

## Analytics (Phase 9)

Open **Analytics** in the sidebar. Tabs:

- **Dashboard** - totals per platform, time-series charts, best and
  worst posts. Filters: last 7/30/90/365 days + platform. Metrics from
  different platforms are not summed together - a TikTok "view" and a
  YouTube "view" mean different things.
- **Compare** - tick 2-20 posts; only metrics every selected post
  actually served are shown; gaps display "-", never a fake 0.
- **Insights** - local, offline analysis (top posts, best platform /
  duration / publish time / hashtags). Each card shows its sample size;
  correlation is never presented as cause.
- **Sync** - manual "Sync now" or automatic interval (off / hourly /
  6h / 12h / daily / weekly). Shows last run, per-target errors
  verbatim, and what each platform can report. Rate limits and expired
  tokens are handled and logged - a failed sync never shows as success.
- **Import** - CSV/JSON stats exported elsewhere (e.g. YouTube Studio).
  Preview first: rows match published posts by remote id; unmatched rows
  are listed and skipped. Imported data is tagged `import` with your
  source label and never overwrites API data. Max 10 MiB.
- **Packets** - self-contained folder per target (video + thumbnail +
  metadata.txt + publication.json) for manual publishing where APIs are
  unavailable. Files are hardlinked when possible, not duplicated.

Post detail shows the latest metrics, metrics the platform cannot
provide (with reason), snapshot history, sync runs and errors, and
charts once enough snapshots exist.

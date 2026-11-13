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
| Audio | Mix, clean up, voice-over |
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

## Where is my data?

- Projects: `.creatora` files wherever you saved them (default: `Documents\Creatora\Projects`).
- App data (library index, settings, accounts): `%APPDATA%\Creatora\`.
- Your videos are never uploaded without your explicit action.

## Troubleshooting

- **Missing media**: Library flags moved/deleted files; use Relink.
- **Crash recovery**: autosaves restore on next launch.
- **Logs**: `%APPDATA%\Creatora\logs\` — attach when reporting issues.

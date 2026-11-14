# UI/UX Redesign Proposal — Creative Pop (Phase 10.5B)

Status: **awaiting approval** — interactive prototype at `/design-preview`
(isolated route, no production wiring).

## 1. What already exists (commit dce8f26 + Phase 10.5A)

The palette, navigation shell and Home are already Creative Pop:

| Token | Value | Use |
|---|---|---|
| graphite | `#17171D` | app background |
| elevated / secondary | `#201F27` / `#292831` | cards, panels |
| coral (`primary`) | `#FF795E` | primary actions, active nav |
| lavender (`accent`) | `#B99AFF` | creative tools |
| lime (`success`) | `#B8F36B` | positive states only |
| butter (`warning`) | `#FFD477` | highlights, suggestions |
| cream | `#F4F0E8` | main text |
| muted | `#A5A0AC` | secondary text |

- Top navigation bar (h-12): Home · Media · Create · Social · Exports ·
  Analytics · Settings — pills with icon+label, active = coral pill.
- Home: hero "What can I make today?" + creation cards + recents.
- Button variants: `creative` (lavender), `positive` (lime).
- Radius 0.75rem; semantic color tokens throughout (no hardcoded hex).

**The remaining work is module-depth redesign, not another palette pass.**

## 2. Canvas manipulation audit (as requested)

Verified in `src/modules/editor/Preview.tsx`:

| Capability | Status |
|---|---|
| Drag to move text/shape/graphics clips | **Works** — `dragClip` writes `transform.x/y`, respects per-version overrides |
| Selection outline + handles on canvas | Missing — selection shows only in timeline/inspector |
| Resize via corner handles (`transform.scale`) | Missing |
| Rotate handle (`transform.rotationDeg`) | Missing |
| Double-click inline text edit | Missing |
| Center/edge snap guides | Missing |

Proposal: a `CanvasOverlay` component drawing a selection box with 4 corner
handles + rotate handle above the preview; writes to the same transform
fields the FFmpeg compositor already consumes — no render changes needed.

## 3. Proposed changes per module

### Editor
- Labeled action buttons in the header (Trim · Text · Music · Captions ·
  Overlay · Export) instead of icon-only controls.
- Advanced controls grouped in collapsible Inspector sections.
- Canvas overlay: selection outline, resize/rotate handles, snap guides,
  double-click text edit.
- Timeline unchanged (pro features preserved).

### Multi-Format → visual platform cards
- Cards shaped as their aspect ratio (16:9 / 9:16 / 1:1 / custom) with
  platform icon + name. Click = create version.
- Active card shows "what changes" strip: crop preview + duration note.

### Subtitle Studio → preset cards with real previews
- Each preset rendered as styled text on a video-dark swatch (Pop, Karaoke,
  Clean, Outline). Click applies existing `SubtitleStyle` — no model change.

### Audio Studio → one-click friendly presets
- Cards: Clear Voice, Reduce Noise, Enhance Voice, Balance Music, Louder —
  each maps to an existing effect chain preset; mixer remains accessible.

### Brand Kit / Graphics → visual identity board
- Color swatches + font samples + logo thumbnails; drag/click to apply to
  selected clips.

### Exports / Social / Analytics
- Already consistent with the token system; polish pass only
  (card radius, status colors, empty states).

## 4. UX principles applied

- Plain-language labels ("Clear Voice" not "compressor+EQ").
- Visual previews before committing (preset swatches, crop strips).
- Common workflows one click from surface; advanced one layer down.
- No new menus or nested panels; no features removed.

## 5. Implementation plan (after approval)

1. `CanvasOverlay` (selection/resize/rotate/snap) — highest interaction value.
2. Multi-Format card grid replacing the version table.
3. Subtitle preset swatches wired to `SUBTITLE_PRESETS`.
4. Audio preset cards wired to existing effect chains.
5. Brand board + Editor header labels.
6. Consistency pass on Exports/Social/Analytics + responsive check
   (1280×720–1920×1080).

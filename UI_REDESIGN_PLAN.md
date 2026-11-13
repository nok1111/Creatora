# UI REDESIGN PLAN — Creative Pop

## Goal
Move Creatora from generic navy-corporate to a warm, expressive
"creative pop" identity for content creators (not pro editors).
Preserve every route, command, store and data structure.

## Audit findings (pre-change)
- Tokens live in `src/index.css` as HSL triplets consumed by
  `tailwind.config.ts` — clean single source, redesign = retoken, not rewrite.
- Left rail `AppShell` (w-14/w-48) — the "administrative" nav to replace.
- `HomePage` = project list page; no creation-intent surface.
- Shared shadcn-style components in `src/components/ui/` — button/input/
  dialog/dropdown/alert-dialog/label. Variant system via cva.
- Accent color hardcodes in a few places (`text-amber-400`, `text-cyan-300`,
  `text-red-500`) — mapped to new accent tokens where they semantically fit.

## Design decisions
- **Foundation**: graphite #17171D; elevated surfaces #201F27 / #292831.
- **Accent hierarchy** (deliberate, not sprinkled):
  - Coral `#FF795E` = primary actions (buttons, active nav, focus ring).
  - Lavender `#B99AFF` = creative-tool accent (accent token, graphics/brand
    hints, "create" cards group).
  - Lime `#B8F36B` = success/positive states only.
  - Butter `#FFD477` = warnings/recommendations only.
  - Cream `#F4F0E8` = foreground on dark.
  - Muted `#A5A0AC` = secondary text.
- **Nav**: top horizontal bar, compact (h-12), icon+label pills,
  coral active pill. Labels: Home / Media / Create / Social / Analytics /
  Settings. Module phase badges removed (all implemented).
- **Home**: "What can I make today?" — 6 creation cards (Edit video,
  Reel/Short, Subtitles, Thumbnail/graphics, Audio, Social post) +
  New Project + Import Media actions + Recent projects (existing logic).
- **Radius**: --radius 0.5 → 0.75rem for friendlier surfaces.
- **Scope discipline**: deep per-module layout redesigns are out of this
  pass; tokens + shell + home + shared components deliver the identity
  shift. Module shells get consistent page-header treatment via tokens.

## Non-goals
No backend changes, no store/route/command changes, no feature removal,
no new dependencies, no illustration library (lucide icons only).

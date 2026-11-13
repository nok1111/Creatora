# DESIGN SYSTEM — Creative Pop

## Color tokens (CSS custom properties, HSL triplets in `src/index.css`)

| Token | Dark value | Use |
|---|---|---|
| `--background` | graphite #17171D | app canvas |
| `--card` / `--popover` | #201F27 / #1B1A21 | elevated surfaces |
| `--secondary` / `--muted` | #292831 | secondary surfaces, hover fills |
| `--foreground` | cream #F4F0E8 | primary text |
| `--muted-foreground` | #A5A0AC | secondary text |
| `--primary` | coral #FF795E | primary actions, active nav, focus ring |
| `--accent` | lavender tint surface | creative-tool surfaces |
| `--accent-foreground` | lavender #B99AFF | creative accents |
| `--success` | lime #B8F36B | success states only |
| `--warning` | butter #FFD477 | warnings, recommendations |
| `--destructive` | warm red | destructive actions |
| `--border` / `--input` | #34333E / #3B3A45 | hairlines, inputs |

Tailwind utilities: `bg-pop-coral|lime|lavender|butter|cream` +
`text-pop-*` for explicit accent use; `bg-success`/`bg-warning` tokens
for semantic states.

## Accent discipline

- Coral — buttons (primary), active nav pill, focus rings, links.
- Lavender — creative surfaces (graphics/brand cards), accent chips.
- Lime — completed states, "done" toasts, passed validation.
- Butter — warnings, "heads up" callouts, insufficient-sample caveats.
- Never two accents fighting in one component.

## Shape & type

- `--radius`: 0.75rem (cards xl = 1rem via `rounded-xl`).
- Font: Inter (UI) / JetBrains Mono (timecode, ids).
- Density: editing surfaces stay compact; marketing surfaces (Home,
  cards) use generous padding (p-5/p-6).

## Component rules

- Buttons: `default` = coral; `secondary` = graphite-2; `creative` =
  lavender; `positive` = lime (new variants). `ghost`/`outline`/`link`/
  `destructive` unchanged.
- Cards: `bg-card rounded-xl border-border`, hover `border-foreground/10`
  + translateY(-1px) for actionable cards.
- Navigation: single top bar h-12; pill active state `bg-primary
  text-primary-foreground`.
- Empty states: icon chip (muted surface) + friendly sentence + one
  clear action.
- Toasts: sonner, themed via tokens (success→lime tint).

## Accessibility

- Coral on graphite: AA for large text/UI (4.5:1 achieved for
  primary-foreground ink #231A14).
- All interactive elements keep focus-visible ring (coral).
- Muted #A5A0AC on graphite = 7:1 — safe for body text.

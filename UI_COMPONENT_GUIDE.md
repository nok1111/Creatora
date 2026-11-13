# UI COMPONENT GUIDE — Creative Pop

## Buttons (`components/ui/button.tsx`)

```tsx
<Button>Save</Button>                 // coral — the ONE primary action
<Button variant="secondary">…</Button> // graphite — neutral actions
<Button variant="creative">…</Button>  // lavender — creative-tool actions
<Button variant="positive">…</Button>  // lime — confirm/complete
<Button variant="outline|ghost|link|destructive">…</Button>
```

Rules: one coral button per view region. Creative for "make something"
actions inside tool surfaces. Positive only for completion/confirmation.

## Navigation (`components/layout/AppShell.tsx`)

Top bar h-12. Active item = coral pill (icon + label). No nested nav.
Module entry points inside workflows deep-link via `?tab=`/`?left=`
params (`/editor?tab=subtitles`, `/social?tab=calendar`).

## Page structure

```
<main scroll area>
  page header: title (text-xl font-semibold) + subtitle muted + actions right
  content sections: cards / panels
```

## Cards

Actionable: `rounded-xl border bg-card p-5 hover:-translate-y-0.5
hover:border-foreground/15 transition` + icon chip `size-11 rounded-lg
bg-<accent>/15 text-<accent>`.

Static panel: `rounded-lg border bg-card` (no lift).

## Empty states

Centered column, muted icon chip (size-14 rounded-2xl bg-secondary),
one sentence, one action button. Never a bare "no data".

## States

- Loading: `animate-pulse` skeleton blocks in content shape.
- Error: toast.error + inline note `text-destructive` + retry action.
- Warning/recommendation: butter text/chip.
- Success: lime text/chip; toast.success.

## Do / don't

- Do: warm cream text, graphite surfaces, coral sparingly.
- Don't: gradients on surfaces, colored borders everywhere, stacked
  accents, tiny gray text on colored backgrounds.

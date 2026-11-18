# Auditoría visual completa — Creatora UI

Evidencia: screenshots reales vía CDP a 1920×1080 y 1440×900 (`qa/shots/uiaudit/`),
medición de contraste WCAG sobre los tokens de `index.css`, y barrido de código
(utility classes, hardcoded colors, tamaños de fuente).

Identidad actual: **"Creative Pop"** — dark-first, grafito + coral + lavanda +
lima + mantequilla + tinta crema. Ya existe una dirección aprobada en
`#/design-preview` (Creative Pop design proposal).

---

## Diagnóstico ejecutivo

La app funciona bien estructuralmente, pero **se ve plana y apagada** por tres
causas medibles, no de gusto:

1. **Las superficies no se separan.** La escala de profundidad
   (surface-0 → surface-3) tiene ~1.1:1 de contraste entre pasos — las cards
   son literalmente invisibles contra el fondo; solo los borders (1.44:1) las
   delimitan. Resultado: todo se lee como una sola masa gris oscura.
2. **Texto demasiado pequeño.** 283 instancias ≤11px (187×`text-[10px]`,
   65×`text-[9px]`, 24×`text-[11px]`, 7×`text-2xs`). En WebView a 100% un
   9px muted es fatiga visual constante.
3. **La marca no existe.** Icono de app genérico teal/amarillo (default de
   Tauri con leve retoque), wordmark "C" en cuadrado, sin fuente propia
   (Inter declarada pero **nunca empaquetada** — cae a Segoe UI/system-ui),
   y detalles en azul genérico que rompen la paleta.

## Contraste medido (tema dark)

| Par | Ratio | Veredicto |
|---|---|---|
| foreground #F4F0E8 / bg #17171D | 15.7 | Excelente |
| muted-fg #A5A0AC / bg | 6.99 | OK |
| muted-fg / card | 6.39 | OK |
| primary #FF795E / bg | 6.92 | OK |
| accent-fg #B99AFF / accent surf | 5.23 | Justo |
| success #B8F36B / bg | 13.66 | Excelente |
| warning #FFD477 / bg | 12.69 | Excelente |
| **border / bg** | **1.44** | Pelo visible apenas |
| **card / bg** | **1.09** | Falla estructural |
| **surface-2 / card** | **1.12** | Falla estructural |

El problema no es legibilidad de texto (bien) sino **jerarquía de superficies**.

## Matriz de hallazgos

### CRITICAL (rompe la identidad o legibilidad)

| # | Ubicación | Problema | Propuesta |
|---|---|---|---|
| V1 | Todo `.dark` | Escala de superficies casi plana (1.09–1.12:1). Cards, panels y raised surfaces no se distinguen. | Retune de la escala: separar cada paso ~+4-5% lightness y aclarar borders (ver §Paleta). |
| V2 | Global | 283 textos ≤11px, 65 de ellos 9px. Sub-labels, metas, chips, hints. | Piso de 11px para contenido real; 10px solo micro-labels; subir line-height en meta rows. |
| V3 | Branding | Icono app teal/amarillo ajeno a la paleta; tile "C" plano; Inter no empaquetada. | **Asset nuevo**: logomark Creative Pop + icon set + Inter woff2 bundled. |

### HIGH (afecta percepción de calidad)

| # | Ubicación | Problema | Propuesta |
|---|---|---|---|
| H1 | Inspector (sliders) | Fill de sliders **azul #3b82f6 genérico** (Opacity, Zoom, etc.) — ajeno a Creative Pop. | `accent-primary` o track neutral + thumb coral. |
| H2 | Exports | Kinds internos sin label: `audio.waveform`, `repurpose.analyze` visibles en la tabla. KIND_KEYS incompleto. | Cubrir todos los kinds + fallback humanizado (`kind.split('.').join(' ')`). |
| H3 | Home | Filas de proyectos densas/planas; icono folder tiny; "Untitled project" repetido sin distinción visual. | Fila con thumbnail del proyecto o tile con aspect-ratio + hora relativa destacada. |
| H4 | Create | Cards de formato usan mini-iconos genéricos en cuadrados oscuros — no comunican aspecto. | **Asset nuevo**: artwork por formato (mini-frames 16:9/9:16/1:1 con motivo de plataforma). |
| H5 | Library | Assets de audio = nota musical genérica; `big_image.png` sin thumbnail (icono genérico). | **Asset nuevo**: placeholder waveform on-brand; investigar por qué la imagen no thumbnailed. |
| H6 | Social posts | Cards de draft con ~70% de espacio muerto; fallback = icono doc soso. | Recompactar la card o thumbnail fallback con marca de plataforma. |
| H7 | Banners | SuggestionBanner (warning-oliva) vs autosave banner (lavanda) vs toasts — 3 familias de aviso distintas. | Unificar sistema de notice (info/warning/action). |

### MEDIUM

| # | Ubicación | Problema | Propuesta |
|---|---|---|---|
| M1 | Effects bin | Categorías con casing inconsistente: `vintage, aesthetic, modern, moody, mono` vs `Cinematic, VFX, Audio Reactive`. | Title-case uniforme + i18n si aplica. |
| M2 | Timeline | Track headers siguen truncados (`V…`, `captions :1`); iconos crípticos persisten. | Header con nombre completo en 2 líneas o tooltip persistente. |
| M3 | Settings | Página escueta; "Retry" huérfano bajo Licenses sin contexto visible. | Cards de sección con descripción; retry con label. |
| M4 | Light theme | Beige lavado, sin la identidad; cards blancas sin profundidad comparable al dark. | Retune paralelo o considerar dark-only si el tema claro no se mantiene. |
| M5 | Analytics | Empty state correcto pero plano; tablas vacías "No data" repetidas. | **Asset**: ilustración spot + tabla colapsada cuando vacía. |
| M6 | Social composer | Columna izquierda con ~60% vacío; Preview card mínima. | Redistribuir: preview con aspecto de post real (frame 9:16 + chips). |
| M7 | Calendar | Sin empty-state dentro del grid; legal line al pie casi invisible. | Hint "drag a post or click a day" + cells con hover. |
| M8 | Editor topbar | "Preview: proxy" chip de texto crudo; densidad alta a 1366. | Chip con estado (dot) + tooltip. |

### LOW

- `design-preview` sigue en prod (ruta dev visible para cualquier usuario).
- Selects nativos sin estilizar consistente con buttons.
- Checkboxes/toggles: revisar accent-color (probablemente azul default igual que sliders).
- Focus rings: `--ring` es coral — verificar que se use en todos los interactives (kbd nav).

## Propuesta de paleta (.dark)

Mantener identidad; arreglar profundidad y bordes:

```css
--background:          240 10% 9%;    /* #14141A — floor más oscuro */
--card:                245 10% 15%;   /* #232229 — antes 14%, ahora separa ~1.35 */
--secondary / muted:   246 9% 20%;    /* #2E2D38 — antes 17% */
--surface-0:           240 11% 7%;
--surface-1:           245 10% 15%;   /* = card */
--surface-2:           246 9% 20%;    /* = secondary */
--surface-3:           250 9% 26%;    /* popovers/hover — antes 21% */
--border:              250 10% 28%;   /* #403E4C — hairlines visibles (1.9:1) */
--input:               252 9% 31%;
--muted-foreground:    265 8% 70%;    /* #AFABB9 — +5% para micro-texto */
```

Ratios resultantes: card/bg ≈ 1.33, surface2/card ≈ 1.30, border/bg ≈ 1.9 —
separación visible sin cambiar el "mood" grafite. Acentos (coral/lavanda/lima/
mantequilla) se mantienen — son lo que funciona de la identidad.

**Sliders/forms:** `accent-color: hsl(var(--primary))` global; track `surface-3`.

**Light theme:** mismo delta relativo (bg crema un punto más oscuro, cards
blancas con hairline + sombra real, borders con más contraste).

## Assets a crear (Devin-made)

| Asset | Uso | Formato |
|---|---|---|
| Logomark Creatora | topbar tile, icono de app, splash | SVG maestro → PNG 32/128/256/512 + ICO |
| Icon set de formato | Create page, VersionsPanel "+ New format", chips de versión | SVG: frames 16:9 / 9:16 / 1:1 / 4:5 con motif |
| Spot illustrations | Empty states (media, proyectos, stats, posts, búsqueda) | SVG line-art paleta brand, ~4 ilustraciones |
| Audio tile | Library + MediaBin audio fallback | SVG waveform on-brand (o WaveformCanvas real) |
| Inter woff2 | `font-sans` real (ahora cae a fallback) | 2-4 pesos subset latin; `@font-face` en index.css |
| Noise/gradient sutil (opcional) | Hero de Home / cards de Create | CSS radial-gradient, sin bitmap |

## Iteraciones propuestas

- **Iteración 1 — Fundamentos: ✅ commit `81fefad`.** Surfaces retuned
  (card/bg 1.09→~1.3, border 1.44→~1.9), `accent-color: primary` global en
  forms, cyan stray eliminado, piso micro-texto 9px→10px (65 archivos…
  clase `text-[9px]` → `text-[10px]`).
- **Iteración 2 — Marca: ✅ implementada.** Logomark propio (C grafito +
  play crema en tile coral, `src/components/BrandMark.tsx`), set completo
  de iconos regenerado desde la misma geometría (`qa/gen_icons.py` →
  `src-tauri/icons/` PNG×15 + ICO multi-size + ICNS), Inter Variable
  bundled vía `@fontsource-variable/inter` (verificado
  `document.fonts.check` → true), topbar usa el mark real
  (screenshot `qa/shots/brand/topbar_app.png`).
- **Iteración 3 — Assets de contenido: ✅ commit `29d3db1`.** FormatArt
  (posters con aspect real en /create + flyout de presets), SpotArt
  (7 ilustraciones para EmptyState, cableadas en todos los módulos),
  AudioTile (waveform determinística para assets de audio en Library +
  MediaBin).
- **Iteración 4 — Detalles: ✅ implementada.** KIND_KEYS cubre
  audio.waveform/beats, media.filmstrip, repurpose.analyze + fallback
  humanizado; chips del Effects bin en title-case; handles de selección
  `bg-white`→`bg-pop-cream`; chip "Preview: proxy" con dot de estado;
  componente `Notice` unifica las familias de banners (SuggestionBanner,
  recovery prompt); tooltip de track headers muestra el nombre completo;
  hint en composer sin plataformas + hint de mes vacío en el calendario.
  Nota: `media.filmstrip` jobs fallan a veces en runtime (input inválido)
  — issue funcional del backend, no de UI; registrado, no arreglado aquí.
- **Iteración 5 — Light theme + regresión: ✅ implementada.** El tema
  claro no definía `--surface-*` ni `--hairline` (causa real del look
  lavado: `bg-surface-*` inválido + `shadow-raise` sin hairline). Añadida
  la escala paralela (floor 89% / cards blancas / raised 97% / hover 92%,
  hairline oscuro), border 84→78%, input 78→70%, muted-fg 42→40%.
  Barrido: EN/ES a 1280×720/1366×768/1440×900, light+dark — sin overflow
  horizontal en ninguna de las 8 rutas.

**Deteniendo aquí — esperando aprobación para implementar por iteraciones.**

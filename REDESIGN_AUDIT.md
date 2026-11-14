# REDISEÑO — Etapa A: Auditoría verificada en código

## A1. Miniaturas rotas — causa raíz (verificado)

`src-tauri/src/media/commands.rs` + `LibraryPage` asset card:

| # | Defecto | Evidencia |
|---|---|---|
| T1 | `<img>` sin `onError` — si el archivo thumb falta o falla, aparece el icono de imagen rota | LibraryPage línea ~78 |
| T2 | `make_thumbnail` devuelve `None` silencioso si ffmpeg falla → `thumbnail_path` NULL para siempre, sin reintento | commands.rs:89-93 |
| T3 | No existe comando `regenerate_thumbnail` — un thumb perdido/corrupto es irreparable desde UI | — |
| T4 | Sin skeleton de carga ni estado "generando" — import muestra icono genérico | — |

Fix planeado: `onError` → placeholder estilado + botón regenerar; comando `regenerate_thumbnail(asset_id)` reusando `make_thumbnail`; estado "missing" ya existe.

## A2. Terminología técnica expuesta (verificado)

- `FORMAT_PRESETS` — `platform` repite "YouTube" 2× e "Instagram" 2×; el usuario no distingue qué cambia. Las cards nuevas muestran dims pero el nombre sigue ambiguo.
- New Project dialog dice **"Canvas preset"** — término técnico.
- VersionsPanel exporta `codec`/`CRF`/`container` crudo en la píldora ⚙.

## A3. Espacio muerto / densidad (verificado en screenshots reales)

- Editor sin proyecto: pantalla vacía con una frase — nada que hacer.
- `/editor` "Create" no guía: crear proyecto exige volver a Home.
- New Project dialog: presets sin representación visual del aspect ratio.
- Home: 6 creation cards OK; pero "Recent exports" vacío ocupa una franja grande sin valor.
- Analytics/Exports/Social: tablas con padding generoso; aceptables, no rotas.

## A4. Estados vacíos (verificado)

Texto plano en todos los módulos ("No jobs match", "No publication attempts", "no captions yet"). Sin ilustración, sin acción, sin guía.

## A5. Navegación (verificado)

Top bar OK. Problemas: "Create" lleva a editor vacío en vez de a un flujo de creación; Settings/Exports conviven con módulos creativos al mismo nivel.

## A6. Iconografía / identidad por módulo

Lucide genérico en toda la app; presets de audio/format ya usan color por familia (lavanda=creativo). Faltan: filetype badges en Library, platform glyphs reales en Social (YouTube/TikTok/IG/FB), iconos de estado de job.

## A7. Profundidad visual

Tokens existen (graphite/elevated/secondary) pero casi todo es `border + bg-card` plano; sin sombras de elevación, sin diferenciación panel/card/dialog.

---

# PROPUESTA — Etapas B–F

## Sistema de diseño (incremental sobre Creative Pop)

- **3 niveles de superficie**: `--surface-0` (#141419 app), `-1` (#1D1C24 panel), `-2` (#26252E card), `-3` (#302E3A popover/dialog). Sombras: `e1` (sutil), `e2` (cards hover), `e3` (dialogs).
- **Borde de hairline** `hsl(0 0% 100% / 0.06)` + sombra interior superior 1px para depth sin glow.
- **Componentes nuevos**: `EmptyState` (icono compuesto + título + copy + acción), `FileBadge` (tipo de archivo), `PlatformGlyph` (glyphs sociales propios SVG), `SectionHeader` (compacto), `RatioCard` (ya existe patrón), `StatCard`.
- **Iconos**: misma familia Lucide pero con **fondo de color por dominio** (video=coral, audio=lima, gráficos=lavanda, social=crema) — identidad por módulo sin iconos custom caros.

## Flujo de creación (Etapa C)

- `/create` → wizard: ① qué haces (video/reel/thumbnail/podcast) → ② formato (cards con shape + plataforma + dims, nombres diferenciados) → ③ importar media (dropzone) → ④ abre Editor.
- Create nav → `/create` (wizard), no editor vacío. Editor vacío → `EmptyState` con CTA "Nuevo proyecto" + "Abrir reciente".
- Terminología: "Canvas preset"→"Formato"; presets→"YouTube · Horizontal", "Shorts · Vertical", etc.

## Módulos (Etapa D)

- **Editor**: barra de acciones etiquetadas (ya hecha), Inspector colapsable, timeline igual.
- **Library**: cards con thumb real + FileBadge + duration/resolution + skeleton + onError placeholder + regen.
- **Multi-Format**: cards con preview de crop real del primer clip (misma matemática `defaultReframe`).
- **Social/Analytics/Exports**: densidad + EmptyState + PlatformGlyph; resto se mantiene.

## Miniaturas (Etapa E)

`regenerate_thumbnail` + `onError` placeholder + skeleton. Sin cambio de contrato.

## Verificación (Etapa F)

Screenshots Win32 reales por módulo a 1280/1366/1920 (ya tengo el harness `/tmp/cap.ps1` funcionando).

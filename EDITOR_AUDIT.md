# Etapa C — Auditoría del Editor (interacción, stacking, timeline)

Evidencia: código fuente + medición en vivo vía CDP (WebView real) + screenshots
(`screenshots/auditC/`). Estado medido: proyecto "Untitled project" 9:16 con un
clip de video horizontal de 23 min, 1920×1080.

## Matriz de problemas

### CRITICAL

| # | Ubicación | Problema | Repro | Impacto | Solución |
|---|---|---|---|---|---|
| C1 | VersionsPanel → "+ New format" | **El popover es invisible y sus opciones no reciben clic.** `absolute bottom-full` dentro del contenedor `overflow-x-auto` (línea 219): cualquier overflow no-visible en un eje recorta ambos → el menú (424px de alto desde y=295) queda reducido a una franja de 50px dentro del contenedor (y=711–761). `elementFromPoint` en el centro de una opción cae sobre el backdrop `z-30` → clic cierra el menú. | Abrir editor → "+ New format". Nada aparece. | El usuario no puede crear formatos multi-aspect desde la UI. Función rota. | Montar el menú con `createPortal` a `document.body`, posicionado por `getBoundingClientRect` del botón (o sacar el popover del contenedor scroll). z-index irrelevante: el problema es clipping, no orden. |
| C2 | GraphicsBin → hover preview de plantillas | Flyout `absolute left-full z-20 group-hover:block` dentro del panel `overflow-y-auto` → recortado por el límite derecho del panel. | Hover sobre una plantilla en el bin gráfico. | El preview de plantillas se ve cortado/invisible. | Portal o posicionarlo relativo al viewport. |
| C3 | Timeline → rueda del mouse | **La rueda no hace nada.** `onWheel` solo procesa Ctrl+rueda (zoom); sin Ctrl el evento cae al `overflow-auto` que no tiene scroll vertical disponible (`canScrollY:false`) → delta 0/0 medido. | Rueda sobre el timeline con un proyecto largo. | Sin navegación horizontal por rueda ni vertical funcional — el timeline de 23 min es innavegable sin arrastrar la barra. | Definir mapa de rueda (propuesta en §scroll): wheel→horizontal, Shift+wheel→vertical, Ctrl+wheel→zoom@cursor. |

### HIGH

| # | Ubicación | Problema | Repro | Impacto | Solución |
|---|---|---|---|---|---|
| H1 | Transporte del preview | Píldora Play/Pause en `absolute bottom-3 left-1/2` del **contenedor de la fila** (que incluye Preview + comparePane). Medido: cy=677 vs centro de video cy=417 → flota sobre las bandas negras del letterbox, 260px bajo el video; con video a pantalla completa cubre contenido; con compare abierto queda entre ambos videos. | Cualquier proyecto vertical con video horizontal (y viceversa). | Controles desconectados del video; sensación amateur. | Montar el transporte dentro de la caja aspect-ratio del canvas (centrado horizontal del video real, docked al borde inferior del canvas, no del contenedor). |
| H2 | Paneles | Todo fijo: bin `w-56`, Inspector `w-64`, timeline `h-64`. Sin separadores arrastrables. | Intentar arrastrar bordes. | El usuario no puede adaptar el espacio a su pantalla/tarea. | Handles de drag con min/max + persistencia en settings store (localStorage), valores por defecto actuales. |
| H3 | Timeline → drag&drop desde Media Bin | `onDragOver` solo hace `preventDefault`: **cero feedback** — sin fantasma de inserción, sin highlight de track destino, sin indicador de posición ni de validez (audio→video track, track bloqueado). | Arrastrar un asset sobre el timeline. | Drop a ciegas; el clip puede caer en un tiempo/track equivocado sin aviso. | Durante `dragover`: calcular lane+ms, dibujar ghost de inserción + highlight del lane + cursor `no-drop` en destinos inválidos. |
| H4 | Clips del timeline | Sin menú contextual ni acceso visible a acciones de clip: split/duplicate/delete viven en toolbar superior con atajos (S, Delete) invisibles para principiantes. | Click derecho sobre un clip → nada. | Acciones esenciales no descubribles. | Menú contextual portal (mismo componente que C1) con entradas i18n: Split/Trim/Duplicate/Delete/Track rename. |
| H5 | Toolbar y tabs del editor | Strings hardcodeados EN: `Trim/Text/Music/Captions/Overlay`, tabs `media`/`graphics`/`Timeline`/`Subtitles` (crudos, minúsculas dev), `+ Video`/`+ Audio`, `Untitled project` default, presets de audio (`Clear Voice`, `Reduce Noise`, …), `Master`, `S`, `Preview: proxy` parcial. | Cambiar idioma a ES → la mitad del editor queda en inglés. | Regresión i18n respecto a G3 en la pantalla más usada. | Barrido i18n de EditorPage/TimelinePanel/AudioTools/VersionsPanel/Inspector. |

### MEDIUM

| # | Ubicación | Problema | Solución propuesta |
|---|---|---|---|
| M1 | Timeline zoom | Solo ±/fit; **sin indicador de nivel** (ni % ni escala temporal legible en la regla más allá de ticks). | Añadir lectura `px/s` o "fit/percentage" junto a los botones. |
| M2 | Scrubbing | Solo en la regla (strip de 24px). No hay scrub al arrastrar sobre lanes vacíos; playhead sin handle ancho. | Ampliar zona de scrub o handle visible; mantener ruler. |
| M3 | Track controls | Iconos crípticos: `S` (speed), candado, ojo, `x` (borra track entero sin confirm), `▲▼` reorder, nombre truncado "V..". | Tooltips i18n + confirmación suave en borrado de track con clips. |
| M4 | `mutateInGesture` | Doc completo re-renderizado por cada `pointermove` (React re-mount del árbol de clips). En timelines densos puede degradar el drag. | Medir en Stage E; si duele, mover el drag a transform visual + commit al soltar (sin perder undo-coalescing). |
| M5 | Compare pane | Con compare abierto el transporte se centra entre ambos previews (ver H1). | Dock por panel o bajo el canvas activo. |
| M6 | Densidad del topbar | Título+toolbar+acciones compiten a 1366; `Untitled project` textual. | Reordenar: acciones primarias compactas con tooltip; nombre del proyecto ya vive en el chip. |
| M7 | Popover "+ New format" | Sin cierre con Escape (solo backdrop click). | Escape listener en el nuevo portal menu. |
| M8 | Drop inválido silencioso | `if (track.locked) return` → el usuario suelta y no pasa nada, sin aviso. | Cursor `no-drop` + toast/hint i18n en drop rechazado. |
| M9 | Sin ghost de clip en drag de medios | El clip existe solo tras soltar. | Preview translúcido durante dragover (mismo cálculo que H3). |
| M10 | Paneles a 1280×720 | Timeline 256px fijo + versions strip + tabs deja ~50% vertical al preview; bin 224+inspector 256 = 37% del ancho. | Con resize (H2) queda mitigado; default responsive por breakpoint. |

## Componentes involucrados

`EditorPage` (layout/topbar) · `Preview` (canvas+transport) · `TimelinePanel`
(wheel/drag/trim/scroll) · `MediaBin` (draggable source) · `VersionsPanel`
(popover) · `GraphicsBin` (flyout) · `Inspector` · `stores/editor`
(gestures/undo) · `timeline-engine` (operaciones).

## Causas estructurales (no cosméticas)

1. **Popovers montados en contenedores con overflow** — el patrón `absolute` +
   z-index dentro de paneles scrolleables es el bug real (C1/C2). Solución
   estructural: un componente `AnchoredMenu` con portal, único, reusable.
2. **Transport anclado al contenedor, no al canvas** — la caja aspect-ratio ya
   existe (`style aspectRatio`); el pill está un nivel por encima.
3. **Wheel map incompleto** — handler existe pero solo cubre Ctrl; el resto se
   delega al navegador que no tiene contenido vertical.
4. **Drop sin feedback** — se implementó dataTransfer sin la capa visual.
5. **Paneles con tamaños en CSS** — sin capa de layout/persistencia.

## Riesgos de romper funcionalidad

- Portal menu: el backdrop z-30 actual ya funciona para click-outside; preservar.
- Wheel→horizontal: `overscroll-behavior:none` ya evita bubbleo; mantener
  Ctrl+wheel zoom con el mismo anclaje al cursor.
- Resize: no tocar `min-h-0/min-w-0` flex contracts; handles solo cambian vars.
- Drag-insert ghost: solo render — `onDrop` real ya funciona (verificado:
  kind/lock checks en `addClip`/`moveClipToTrack`).
- `mutateInGesture` + undo coalescing: no tocar el modelo de undo.

## Plan de pruebas (por iteración)

- **A/B** (menús+transporte): `elementFromPoint` en cada opción del menú a
  1280/1366/1920 y con scroll; clic real selecciona; Escape/backdrop cierran;
  screenshot del popover abierto completo.
- **C** (resize): drag del handle → medir rects antes/después, persistencia tras
  reload, clamps a mínimos, cursor correcto, sin selección de texto.
- **D** (drag&drop): dispatch real de dragstart/dragover/drop; ghost visible;
  drop válido añade clip en el ms correcto; inválido (audio→video, locked)
  muestra no-drop y no muta; Undo revierte.
- **E** (wheel/zoom): wheel→scrollLeft cambia; Shift→scrollTop; Ctrl→zoom
  anclado (scrollLeft se ajusta para mantener cursorMs estable); indicador de
  zoom actualizado.
- **F/G**: regresión completa (move/trim/split/undo/redo/save/reopen/export
  real) + screenshots 1280/1366/1920 EN/ES.

**Deteniendo aquí — esperando aprobación para implementar por iteraciones.**

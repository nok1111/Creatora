# EDITOR_LIVE_QA_REPORT — Etapa C.1

Fecha: 2026-11-14
Commits bajo prueba: `822294b` (AnchoredMenu), `5f60534` (Preview), `eae4b12` (Timeline/DnD), `e7e8713` (Paneles), `db0ce9e` (i18n)
Fix aplicado durante el QA: `690e3ea` (autofocus de AnchoredMenu)

## Método

- App real: `creatora.exe` (debug) sobre WebView2, Vite dev en `http://localhost:1420`.
- Automatización: CDP en `localhost:9222` mediante `qa/cdp.py` — eventos de input reales (`Input.dispatchMouseEvent`, `dispatchKeyEvent`), no jsdom ni simulación de funciones internas para las interacciones bajo prueba.
- Setup del proyecto (crear proyecto, importar medios, crear pistas) vía IPC Tauri real; todo lo demás por UI.
- Proyecto de prueba: video h264 720p (6s), video vertical 9×16 (4s), audio mp3 (5s), imagen png — pistas V1, V2 (renombrada QA2), A1, G.
- Mediciones con `getBoundingClientRect` y `elementFromPoint`.
- Evidencias en `qa/shots/`.

## Matriz de resultados (20 puntos)

| # | Prueba | Resultado | Evidencia / medición |
|---|--------|-----------|----------------------|
| 1 | New Format: abrir/seleccionar | **PASS** | Portal a `document.body`, rect {x:142,y:294,w:420,h:424}, sin clipping, item click crea versión. `02_newformat_open.png` |
| 2 | Flyout GraphicsBin | **PASS** | Portal, sin clipping; en micro-scroll controlado el flyout sigue al card (y 339→335→331 en ambos). `03_gfxbin_flyout.png` |
| 3 | Menú contextual de clip | **PASS** | Items correctos, Split deshabilitado con playhead fuera del clip (correcto). `04_clip_context_menu.png` |
| 4 | Video MediaBin → Timeline | **PASS** | Payload `application/x-creatora-asset` + path + duration; drop crea clip en la posición indicada por el ghost (x=752 ghost = x=752 final). `10_valid_dragover_ghost.png` |
| 5 | Mover clips | **PASS** | Drag pointer real: +182px; clip reubicado exactamente donde el ghost. |
| 6 | Recortar clips (trim) | **PASS** | Ambos bordes: handle izquierdo y derecho modifican in/out con cursor `ew-resize`. |
| 7 | Mover entre tracks | **PASS** | V1→QA2: lane destino con `bg-primary/15`, clip reubicado. |
| 8 | Track bloqueado | **PASS** | `dropEffect:none`, ghost destructivo, highlight, toast "Track is locked", sin mutación. `09_locked_drop.png` |
| 9 | Undo/Redo | **PASS** | Delete → Ctrl+Z restaura clip; multi-select con Ctrl+click (2 clips, "2 selected"). |
| 10 | Wheel → scroll horizontal | **PASS** | `scrollLeft` 240→480→720 sobre clips y sobre regla; no afecta MediaBin (scrollLeft inmutable allí). |
| 11 | Shift+Wheel → vertical | **PASS** | `scrollTop` 0→28→0 con overflow de pistas. |
| 12 | Ctrl+Wheel → zoom temporal | **PASS** | pxPerSec cambia; tiempo bajo el cursor preservado: 4585ms antes y después. Botones zoom in/out/fit OK. |
| 13 | Resize de paneles | **PASS** | Bin 223→303→167(min)→479(max clamp); Inspector 256→336; Timeline h drag arriba/abajo. Doble-clic reset 223; teclado ±16/±48. |
| 14 | Persistencia tras reinicio | **PASS** | Tras reload: bin 271≈272, inspector 336 — valores `editor.panel.*` restaurados. |
| 15 | Play/Pause | **PASS** | Playhead avanza y se detiene; transporte anclado al stage. |
| 16 | Formatos horizontal/vertical/cuadrado | **PASS** | 9:16 stage 311×554 dx=0; 16:9 984×554 dx=0; 1:1 554×554 dx=0. Compare: dos panes, transporte por pane. `05`–`08` |
| 17 | Graphics: insertar/transformar | **PASS** | Template → diálogo de texto → clip "clip·3.0s" en pista G; keyframe ◇→accent (transform.opacity, 2 kf). |
| 18 | Subtítulos | **PASS** | Tab SUBTITLES; "Add cue" crea cue; panel de transcripción/modelos presente. `11_subtitles_tab.png` |
| 19 | Guardar/cerrar/reabrir | **PASS** | Ctrl+S → toast saved; Home → Open in editor → 4 lanes / 5 clips intactos, versiones Master+Square persistidas. |
| 20 | Exportación FFmpeg real | **PASS** | `export_project` → job `done`; `qa-c1-export.mp4` 3.36MB, h264 1080×1920@30 + aac, dur 10.2s (verificado con ffprobe); aparece en Recent Exports. |

### Pruebas adicionales ejecutadas

| Prueba | Resultado | Detalle |
|--------|-----------|---------|
| AnchoredMenu: Escape / outside-click / trigger-toggle | PASS | Cierra correctamente en los 3 casos. |
| AnchoredMenu: navegación por teclado | **FAIL → FIXED** | Ver defecto D1 abajo. |
| AnchoredMenu: resize de ventana | PASS | Menu re-placed y clampeado al nuevo viewport (y 284→8). `12_menu_after_resize.png` |
| Drop tipo incompatible (audio→pista video) | PASS | No-drop + ghost destructivo + toast específico. |
| Snapping | PASS | Drop a ~10px del borde de otro clip aterriza exacto (x=980). |
| Split en playhead | PASS | 6s → 2s+4s. |
| Copy/Paste (Ctrl+V) | PASS | Duplicado creado. |
| Rename track (doble-clic) | PASS | V2 → QA2 con input inline. |
| Transición crossfade | PASS | Creada 0.50s entre clips adyacentes (botón requería scroll del Inspector). |
| Preset de audio ("Louder") | PASS | Aplica efecto Limiter levelDb −1.00 en el clip. |
| Smart Reframe (auto) | PASS | "Reframe applied — 2 clip(s) tracked", keyframes transform.x/y escritos. |
| Audio preset en efectos | PASS | Inspector muestra efecto aplicado. |

## Defectos encontrados

### D1 — Navegación por teclado de AnchoredMenu inoperante — **CORREGIDO** (`690e3ea`)

- **Reproducción**: abrir New Format → `document.activeElement` quedaba en el trigger; ArrowDown/Up/Enter no hacían nada.
- **Causa**: el autofocus `useEffect` llamaba `focus()` mientras WebView2 aún reportaba el ítem `visibility:hidden` (contenedor ya visible; los ítems tardan ~50–80ms en volverse visibles tras montar el portal). `focus()` sobre elemento hidden es no-op.
- **Evidencia**: instrumentación de `HTMLElement.prototype.focus` — `{vis:'hidden', after:'+ New format', same:false}`; muestreo cada frame mostró `item:hidden` ×4 frames → `visible`.
- **Corrección mínima**: reintentar el `focus()` por frame hasta que `document.activeElement` sea el target, acotado a 10 frames. Test actualizado para esperar el frame diferido.
- **Verificación post-fix**: autofocus en "16:9 YouTube", ArrowDown/Up/Home/End roving OK, Enter activa el preset y crea la versión. tsc limpio, vitest 100/100, vite build OK.

## Limitaciones

- **Diálogo nativo "Choose destination…"**: no automatizable por CDP (diálogo del SO fuera del WebView). La exportación se validó invocando `export_project` real con los mismos parámetros que envía el diálogo — el pipeline FFmpeg es el mismo. BLOCKED solo el clic al file-picker.
- **HTML5 drag real desde MediaBin**: WebView2/Chromium no genera `dragstart` desde `Input.dispatchMouseEvent` sintético; se inyectó un `DataTransfer` real con el payload que produce `dragstart` (verificado) y se despacharon dragover/drop nativos. La ruta de pointer-drag interna (mover/trim clips) sí usó pointer events reales.
- **Transcripción de subtítulos (Whisper)**: panel y cue manual verificados; la descarga/transcripción completa del modelo no se ejecutó por duración.
- El scroll-follow del flyout se verificó con micro-scroll controlado (el panel no genera overflow natural al viewport actual; con scroll suficiente el hover se limpia correctamente — comportamiento deseado).

## Regresiones detectadas

Ninguna funcional rota. Observaciones menores (no defectos):

- El botón "Add transition" queda por debajo del fold del Inspector (y≈1121); requiere scroll — UX normal de panel, no clipping.
- El asset `xvideos.com_…mp4` (preexistente del usuario) figura como "missing media" — dato del usuario, no del cambio.

## Conclusión

20/20 puntos verificados en vivo. 1 defecto confirmado y corregido en commit independiente (`690e3ea`). Sin regresiones. Listo para revisión/aprobación.

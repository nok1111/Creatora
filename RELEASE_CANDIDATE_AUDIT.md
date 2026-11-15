# Creatora — Release Candidate Audit (Etapa A)

Fecha: build `e59f1df..f4c05f2` sobre `main`. Ámbito: distribución, dependencias del
entorno de desarrollo, base de datos y persistencia. **Sin cambios de código.**

## Resumen

No se han encontrado problemas **Critical** estáticos. El instalador NSIS generado
(62 MB, `Creatora_0.1.0_x64-setup.exe`) contiene solo lo necesario: `creatora.exe`,
`tools/bin/{ffmpeg,ffprobe,whisper-cli}.exe` y `tools/THIRD_PARTY_NOTICES/{LICENSE,README.txt}`.
La mayoría de los hallazgos son metadatos de distribución y un riesgo real de CSP
divergente dev/prod.

---

## HIGH

### H1 — Instalador y ejecutable sin firma digital
- **Evidencia**: `installer.nsi` no invoca `signtool`; `SIGNCOMMAND`/`UNINSTALLERSIGNCOMMAND`
  vacíos. `MANUFACTURER "creatora"` sin publisher verificado.
- **Riesgo**: Windows SmartScreen mostrará "Unknown publisher / unrecognized app" al
  instalar. Esperable en software sin firmar, pero es fricción comercial real.
- **Corrección propuesta**: documentarlo en `KNOWN_ISSUES.md`/`RELEASE_NOTES.md` como
  limitación aceptada, o adquirir certificado EV/OV antes de distribuir. Decisión de
  producto, no de código.
- **Pruebas**: instalación real en Stage B documentando el aviso exacto.

### H2 — Metadatos de versión/producto de pre-release
- **Evidencia**: `version = "0.1.0"` en `tauri.conf.json`/`Cargo.toml`/`package.json`;
  `MANUFACTURER "creatora"` (minúsculas), `HOMEPAGE ""`, sin EULA (`LICENSE ""`).
- **Riesgo**: para una RC comercial la versión visible debería ser `1.0.0` y el
  fabricante consistente con la marca.
- **Corrección propuesta**: bump a `1.0.0` + `authors`/productName finales (decisión del
  usuario: "Creatora" vs "Ascension Creator").
- **Pruebas**: `app_info`, propiedades del exe, página About del instalador.

### H3 — Divergencia CSP dev/prod en `index.html`
- **Evidencia**: `index.html` meta CSP incluye `img-src ... https:` mientras
  `tauri.conf.json` `csp` no incluye `https:` en img-src. En dev (Vite) solo aplica
  el meta → **una imagen https remota funcionaría en dev y se bloquearía en prod**
  (el header de la conf siempre aplica en producción; el meta no puede relajarlo).
- **Riesgo**: si la UI carga imágenes remotas (p. ej. avatares de plataformas sociales,
  previews de publish packets externos), fallarían en producción sin error visible en dev.
- **Corrección propuesta**: igualar ambos CSP (o eliminar el meta si la conf es la fuente
  de verdad) y verificar en Stage C si algún módulo carga imágenes `https:`.
- **Pruebas**: buscar `https://` en src para imágenes; verificación visual en prod.

### H4 — Identificador `com.creatora.app` con sufijo `.app`
- **Evidencia**: warning de `tauri build`: "bundle identifier ends with `.app` —
  conflicts with the application bundle extension on macOS". AppData dir:
  `Roaming\com.creatora.app`.
- **Riesgo**: ninguno en Windows; bloquea/ensucia una futura build macOS. Cambiarlo
  después de publicar rompería la ubicación de datos de usuarios existentes
  (nuevo dir de appdata → “pérdida” aparente de biblioteca/config).
- **Corrección propuesta**: decidir ahora — mantener `com.creatora.app` (Windows-only RC)
  o migrar a p.ej. `com.creatora.studio` **antes** de la primera release, con migración
  de datos si cambia.
- **Pruebas**: decisión de producto + test de migración de appdata si se cambia.

## MEDIUM

### M1 — Sin single-instance
- **Evidencia**: no hay plugin/config single-instance. Dos instancias comparten la
  misma SQLite (WAL lo tolera) pero pueden lanzar exports/autosaves duplicados.
- **Riesgo**: bajo uso real; posible corrupción de estado de jobs en carrera.
- **Corrección**: documentar como limitación (no instalar plugin por "limpieza" ahora);
  evaluar `tauri-plugin-single-instance` en una fase posterior si hay reportes.

### M2 — Fallback `models_dir` a `"."` si `app_data_dir()` falla
- **Evidencia**: `subtitles/commands.rs:44` → `unwrap_or_else(|_| PathBuf::from("."))`.
  Escribiría modelos en el cwd del proceso si AppData no se resuelve.
- **Riesgo**: muy improbable (AppData siempre resuelve en Windows); comportamiento
  confuso si ocurriera.
- **Corrección**: devolver `Option` y propagar error (1 línea + call sites) — barato.

### M3 — Migración 0003 no registrada (riesgo solo en DBs dev antiguas)
- **Evidencia**: `migrations.rs` omite `0003_proxy_path.sql` porque el `0001` actual ya
  incluye `proxy_path`. Una DB creada con un `0001` pre-proxy (user_version=1 viejo)
  jamás obtendría `proxy_path` → `list_assets` fallaría con "no such column".
- **Riesgo**: solo afecta a DBs generadas con builds de desarrollo antiguos; la DB real
  del usuario ya tiene `proxy_path` (verificado). Una RC limpia para usuarios nuevos
  no lo sufre.
- **Corrección**: re-registrar 0003 con `IF NOT EXISTS`-safe (SQLite no lo soporta en
  ADD COLUMN → hacer migración 0008 defensiva `ALTER ... ` envuelta) o documentar que
  builds pre-proxy deben borrar la DB. Recomiendo el ALTER defensivo vía chequeo de
  `PRAGMA table_info` en 0008 — mínimo y seguro.
- **Pruebas**: crear DB con 0001 antiguo → abrir con RC → `list_assets` funciona.

### M4 — `.creatora` sin asociación de extensión / sin deep-link
- **Evidencia**: `tauri.conf.json` no registra `fileAssociations`; no hay handler de
  argv. Abrir doble-click en un `.creatora` no lanza la app.
- **Riesgo**: fricción UX, no pérdida de datos. Aceptable como known issue; registrar
  asociación + handler `RunEvent::Opened` es una feature pequeña pero no trivial.
- **Corrección**: documentar en KNOWN_ISSUES; no implementar ahora salvo aprobación.

## LOW

- **L1 — WebView2**: bootstrapper embebido (~1.5MB) pero descarga el runtime online si
  falta. Win10/11 modernos lo traen. `webviewInstallMode` offline añadiría ~130 MB.
  Documentar requisito.
- **L2 — `dev_models_root` en prod** apunta a `<exe>/tools/models` (inexistente) —
  scan inofensivo; modelos reales viven en AppData (descargados con consentimiento).
- **L3 — `console.error/warn`** en 6 sitios frontend — diagnóstico aceptable, sin
  consola visible en build windows-subsystem.
- **L4 — OAuth social sin credenciales embebidas** (por diseño): `oauth_client_id.*`
  viene de la tabla settings del usuario. Documentar en notas que la publicación real
  requiere que el usuario registre sus propias apps de plataforma — alineado con
  "sin servicios cloud propios".
- **L5 — `panic = "unwind"` + logs en AppData**: correcto; solo comprobar que el
  log dir no crece sin límite (plugin-log rota por fecha; sin cap de tamaño — nota).
- **L6 — `identifier` en AppData**: si H4 cambia el identificador, migrar
  `Roaming\com.creatora.app` → nuevo dir con copia de DB.

## Verificado correcto (sin acción)

| Área | Evidencia |
|---|---|
| Contenido del bundle | `installer.nsi` instala solo `tools/bin/*` + `tools/THIRD_PARTY_NOTICES/*`; models/test-media/whisper-src excluidos |
| Dependencias de desarrollo | `CARGO_MANIFEST_DIR` solo bajo `cfg!(debug_assertions)` (3 sitios); cero refs a node_modules/localhost/Vite en `src/` |
| Variables de entorno | `CREATORA_*` son overrides opcionales; prod usa `tools/bin` junto al exe |
| Runtime deps | CRT estático (no `vcruntime140`); WebView2 bootstrapper embebido en NSIS |
| Instalación | `INSTALLMODE=currentUser` → `%LOCALAPPDATA%\Programs\Creatora`, sin admin |
| Desinstalación | borra `$INSTDIR`; AppData solo si el usuario marca el checkbox (opt-in) |
| Migraciones | `user_version` transaccional por migración; 0007 aplica `error` (DB real verificada con la columna) |
| `.creatora` | `format_version=1`, save atómico (tmp+rename), autosave + diálogo de recovery en Home |
| Jobs | `sweep_interrupted` marca trabajos cortados al arranque; errores persistidos (G1) |
| Secretos | client_id OAuth desde settings del usuario; nada embebido |
| Licencias | LICENSE+README (GPL v3, commit fuente) en el instalador y accesibles desde About |
| Seguridad asset | `scope: $APPDATA/**` + autorización por directorio de asset registrada (verificado G4) |

## Plan de verificación Stage B (entorno)

No hay VM Windows disponible → aproximación: instalación silenciosa (`setup.exe /S`)
en un **perfil Windows secundario** en esta máquina (AppData/LocalAppData vírgenes),
o al menos en ruta de instalación alternativa + `%APPDATA%`/`%LOCALAPPDATA%` nuevos.
**Limitación documentada**: el sistema huésped ya tiene WebView2, FFmpeg en PATH y
SDKs — las pruebas usan el binario empaquetado (los tools se resuelven primero desde
`$INSTDIR/tools/bin`, no del PATH), pero no garantiza un equipo limpio absoluto.

Automatizable: instalación `/S`, primer arranque, verificación vía CDP de flujos
(importar→thumbnail→preview→exportar→reabrir), desinstalación, reinstalación.
Manual/requiere usuario: SmartScreen real en equipo nuevo, cuentas sociales reales.

## Correcciones propuestas (pendientes de aprobación)

| # | Fix | Esfuerzo |
|---|---|---|
| 1 | Bump versión a 1.0.0 + manufacturer/homepage (decisión: nombre final) | XS |
| 2 | Alinear CSP de index.html con tauri.conf (eliminar divergencia https:) | XS |
| 3 | Migración 0008 defensiva `proxy_path` (table_info check) | S |
| 4 | `models_dir` → propagar error en vez de `.` | XS |
| 5 | (Opcional) añadir EULA/copyrightProduct; página de licencia NSIS | XS |
| 6 | (Decisión) cambiar identifier a `com.creatora.studio` + migración appdata | M |

Sin propuestas de features nuevas. Esperando aprobación para Stage B.

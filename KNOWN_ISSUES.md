# Creatora — Known Issues (RC1)

## Distribution

- **No code signing** — Windows SmartScreen warns "unknown publisher" on
  install and first run. This is expected for this RC; a future public build
  will ship signed with an EV/OV certificate.
- **No auto-update** — each release is installed manually. Uninstalling keeps
  your projects and settings unless you opt to delete them.

## Editor

- **Single instance not enforced** — running two Creatora windows at once can
  duplicate jobs/autosaves. Open one instance at a time.
- **Large projects and long sessions** have not been stress-tested; autosave
  runs periodically and a recovery copy is kept, but save important work.

## Subtitles

- Whisper models must be **downloaded inside the app** before first use
  (internet required once, per model). Transcription itself runs fully offline.
- `ggml-tiny` trades accuracy for speed — review auto-captions before export.

## Social & Analytics

- Connecting social accounts requires **internet** and OAuth client IDs that
  you configure in Settings (no platform secrets ship with the app).
- Platform statistics depend on each platform's API availability and scopes.

## Database

- Libraries created by very early **development builds** may lack the
  `proxy_path` column; RC1 installs and the shipped 1.0.0 schema are not
  affected. If you imported a dev-era DB, start fresh or contact support.

## Environment notes

- HTML5 drag from MediaBin to Timeline: verified in the development build;
  final physical confirmation on the installed build is tracked in the
  release report.

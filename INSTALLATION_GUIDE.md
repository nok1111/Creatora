# Creatora — Installation Guide

## Requirements

- Windows 10 or 11, 64-bit.
- Microsoft Edge WebView2 Runtime — present on most Windows 10/11 systems;
  the installer downloads and installs it automatically if missing.
- ~500 MB free disk space for the app (plus space for your media and
  optional Whisper models: tiny 78 MB, base 148 MB, small 488 MB).

## Install

1. Run `Creatora_1.0.0_x64-setup.exe`.
2. Windows SmartScreen may show "Windows protected your PC" because the app
   is not yet code-signed. Click **More info → Run anyway** to continue.
3. The installer places Creatora in `%LOCALAPPDATA%\Programs\Creatora`
   (per-user, no administrator rights required) and adds a Start Menu entry.

Silent install (for IT/testing):

```
Creatora_1.0.0_x64-setup.exe /S
```

Custom directory:

```
Creatora_1.0.0_x64-setup.exe /S /D=C:\Tools\Creatora
```

## Where your data lives

| Data | Location |
|---|---|
| Projects (`.creatora` files) | `Documents\Creatora\Projects\` |
| App data (library DB, thumbnails, settings, jobs) | `%APPDATA%\com.creatora.app\` |
| Whisper models | `%APPDATA%\com.creatora.app\models\` |
| Social account tokens | Windows Credential Manager (never on disk) |

## First run

1. Open Creatora → create a project from Home or Create.
2. Import media from the Media panel (videos, audio, images).
3. Edit on the Timeline, then **Export** from the editor toolbar.
4. For subtitles: open the Subtitles panel, download a Whisper model once,
   then transcribe — works offline afterwards.

## Uninstall

Use **Settings → Apps → Creatora → Uninstall** (or the Start Menu shortcut).
Your projects in `Documents\Creatora\Projects` and your app data in
`%APPDATA%\com.creatora.app` are **kept** unless you tick the option to
remove them during uninstall.

## Troubleshooting

| Problem | Fix |
|---|---|
| Blank window on first start | Reinstall WebView2 Runtime, restart the app. |
| "Media missing" in a project | Files moved/renamed — relink them from the asset's context menu in Media Library. |
| Transcribe button does nothing | Download a Whisper model first (Subtitles → model → Download). |
| Export fails immediately | Check the file has enough free disk space next to the destination folder; FFmpeg is bundled, no install needed. |
| SmartScreen blocks install | Expected for unsigned builds — More info → Run anyway. |
| App won't open a second window | Only one instance should be run at a time. |

# Creatora — Privacy & Data

## What Creatora stores locally

Everything Creatora creates lives on your PC — there is no Creatora cloud.

| Data | Where | Notes |
|---|---|---|
| Projects | `Documents\Creatora\Projects\*.creatora` | Plain project files you can back up or move. |
| Media library index, settings, job history | `%APPDATA%\com.creatora.app\` (SQLite) | Asset paths and metadata — your media files are never copied. |
| Thumbnails | `%APPDATA%\com.creatora.app\thumbs\` | Regenerated on demand. |
| Whisper models | `%APPDATA%\com.creatora.app\models\` | Only models you explicitly download. |
| Panel sizes, language, preferences | settings table in the app DB | Restored on every launch. |
| Social OAuth tokens & client secrets | **Windows Credential Manager** (DPAPI) | Never written to disk or the database. |

Your media files stay where you put them. Creatora only references their
paths; moving a file requires relinking from the Media Library.

## Network communication

Creatora makes **no telemetry, analytics or tracking calls** and has no
auto-updater. The network is used **only** when you explicitly:

| Action | Endpoints |
|---|---|
| Connect a social account (OAuth) | `accounts.google.com`, `www.tiktok.com`, `www.facebook.com` and each platform's token endpoint |
| Publish a video | `upload.youtube.com`, `graph-video.facebook.com`, `open.tiktokapis.com` |
| Refresh statistics | `www.googleapis.com`, `youtubeanalytics.googleapis.com`, `graph.facebook.com`, `open.tiktokapis.com` |
| Download a Whisper model | `huggingface.co` (one download per model) |

Editing, previewing, subtitles (after the model download) and exporting all
work **fully offline**.

## Connecting social accounts

- You sign in on the platform's own website (your browser) — Creatora never
  sees your password.
- The returned tokens go to Windows Credential Manager, encrypted by Windows
  under your user account.
- Client IDs are stored in the app's settings table (they are public by
  design); client secrets, if you configure them, go to Credential Manager.
- Disconnecting an account removes its tokens from Credential Manager.

## What is sent to platforms

Only what you publish or request: the video file and metadata you approve at
export/publish time, and read-only statistics requests for your own accounts.
Nothing is uploaded automatically.

## Uninstalling

Uninstall removes the program files. Your projects, media, models and
settings remain on disk unless you tick the "remove app data" option.
Credential Manager entries created by Creatora are removed when you
disconnect the accounts inside the app.

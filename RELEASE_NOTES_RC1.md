# Creatora 1.0.0 — Release Candidate 1

First distributable build of Creatora, the all-in-one creator studio for Windows.

## What is Creatora

A desktop video editor and creator workflow app:

- **Editor** — multi-track timeline with drag & drop, trimming, snapping, keyframes,
  transitions, audio tools, graphics/titles and per-format versions.
- **Multi-Format** — one project renders horizontal (16:9), vertical (9:16) and
  square (1:1) versions, with Smart Reframe.
- **Subtitles** — local Whisper transcription (models download on demand),
  cue editing, styling, SRT/VTT/ASS export and burn-in at export.
- **Media Library** — import video, audio and images with thumbnails.
- **Export Center** — real FFmpeg renders (H.264/AAC, MP4/MOV/MKV/WebM presets).
- **Social Studio & Analytics** — publish packets to YouTube, TikTok and
  Facebook via OAuth, and pull platform statistics.
- **Bilingual** — English and Spanish UI.

## Changes since the last internal build

- Editor UX polish: anchored menus, resizable panels, timeline wheel/zoom,
  preview transport positioning, i18n sweep (en/es).
- Fix: keyboard navigation in menus (WebView2 autofocus timing).
- Fix: multi-selected clips now move together when dragged.
- Fix: remaining English strings in the Spanish UI.
- Fix: subtitle model directory now fails cleanly if app data is unavailable.
- Internal: dev/production CSP aligned.

## Platform

- Windows 10/11, 64-bit.
- Installs per-user to `%LOCALAPPDATA%\Programs\Creatora` — no admin rights needed.
- WebView2 Runtime required (bootstrapped automatically by the installer).
- FFmpeg, FFprobe and whisper-cli are bundled — no external installs needed.

## Known limitations

- The installer and executable are **not code-signed** — Windows SmartScreen
  will show an "unknown publisher" warning. See `KNOWN_ISSUES.md`.
- Whisper models are **not bundled** — download them inside the app
  (Subtitles panel → model picker) before transcribing offline.
- See `KNOWN_ISSUES.md` for the full list.

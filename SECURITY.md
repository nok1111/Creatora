# SECURITY.md

How credentials, tokens and user data are handled. Local-first: nothing leaves the machine unless the user explicitly publishes.

## Credential storage

- **OAuth tokens** (access + refresh) live in **Windows Credential Manager** via the `keyring` crate — OS-managed, DPAPI-encrypted per Windows user. Never written to SQLite, `.creatora` files, logs, or exported bundles.
- **Social account passwords are never collected.** Auth is OAuth 2.0 only.
- Disconnecting an account (`disconnect_social_account`) deletes the keyring entry AND the DB row — no token residue.
- `social_accounts` stores only non-secret metadata: platform, display name, account id, scopes granted, expiry timestamp.

## OAuth flow

- Authorization-code + **PKCE** (S256) + **loopback redirect** on `127.0.0.1` with a random ephemeral port (RFC 8252). A local listener waits 3 minutes for the redirect; no inbound firewall rule needed.
- `state` is a random nonce checked on callback (CSRF protection).
- **Client id/secret are configured by the user** (their own developer app) in Settings → no secrets embedded in the binary. Client secret, if supplied, is stored in the same keyring vault.
- Tokens refresh only inside a publish job; refresh failures mark the target `failed` and surface the platform's error verbatim.

## What is NOT in the binary

- No OAuth client secrets, no API keys, no tracking, no telemetry.

## Data transmission

- Files are uploaded **only** when the user clicks "Publish" on a ready target, or when an `auto_publish` scheduled target fires. There is no background sync.
- The scheduler is local: without `auto_publish` it emits a `social://due` reminder event and nothing is sent.

## Logging

- Adapter error paths store HTTP status + sanitized body (token fields stripped) in `publication_attempts.error`. Tokens are never logged; app logs in `%APPDATA%\Creatora\logs` contain paths and statuses only.

## Legacy note

The early `publications` table (migration 0001, `account_id NOT NULL`) is unused — the Phase 8 model (`social_posts`/`social_post_targets`) separates creative content from credentials by design.

## Phase 9 additions

- Imported files: 10 MiB hard cap, strict CSV/JSON parsing, rows are
  data only - nothing eval'd, rendered as HTML, or used to build shell
  commands; values bound via rusqlite parameters.
- Endpoint overrides (ep()): test-only hook, never exposed over IPC.
- Provider error bodies are surfaced verbatim for debugging; access
  tokens travel only in Authorization headers, never in URLs/messages.
- Disconnecting an account stops sync but does not delete stored
  snapshots - user data stays under user control.

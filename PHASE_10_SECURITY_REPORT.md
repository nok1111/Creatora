# PHASE 10 — SECURITY REPORT

## Fixes applied

| ID | Finding | Fix |
|---|---|---|
| H1 | `csp: null` — no Content-Security-Policy on the webview | Strict CSP added (see below) |
| M3 | Jobs left `running` after a crash showed as phantom work forever | Startup sweep → `interrupted` + regression test |
| L1 | `@tauri-apps/plugin-fs` — unused npm dependency | Removed (reduces attack surface + lockfile noise) |
| L2 | No size cap on `.creatora` open — giant file → memory spike | 64 MiB hard cap + regression test |

CSP applied (`tauri.conf.json`):

```
default-src 'self'; script-src 'self';
connect-src 'self' ipc: http://ipc.localhost;
img-src 'self' asset: http://asset.localhost data: blob:;
media-src 'self' asset: http://asset.localhost blob:;
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
object-src 'none'; base-uri 'self'
```

- `script-src 'self'` blocks inline/eval'd script — primary XSS kill.
- `style-src 'unsafe-inline'` is required: timeline/preview position
  elements with dynamic `style={}` — documented exception, not laxness.
- `object-src 'none'` kills plugin/object embedding entirely.
- OAuth/API calls happen in Rust — the webview needs no remote
  `connect-src` at all.

## Documented residual risks (accepted, with rationale)

1. **assetProtocol scope `["**"]`** — the webview can request any local
   file through the asset protocol. *Required*: users import media from
   arbitrary drives/folders; narrowing the scope would break the core
   product. Mitigations: CSP (no injected script can exfiltrate),
   React escaping everywhere (zero `dangerouslySetInnerHTML` — verified),
   and the protocol only *serves* files to the webview, it cannot write.
2. **cargo-audit not run** — tool not installed in this environment;
   `Cargo.lock` advisory scan deferred to Phase 11 CI (recorded).
3. **`style-src 'unsafe-inline'`** — see above.

## Re-verified (no change needed)

- Tauri capabilities: `core:default` + `dialog:default` only.
- No `dangerouslySetInnerHTML`/`innerHTML` writes in `src/`.
- All subprocesses use `Command::arg()` vectors — no shell strings, so
  no metacharacter injection via filenames/metadata.
- `reveal_path` uses `explorer /select,` + separate arg.
- Import pipeline: 10 MiB cap, 50k row cap, rusqlite parameter binding,
  no eval/exec of imported content; imported rows tagged `import`,
  never overwrite API data.
- Filtergraph escaping for drawtext/subtitles paths and text content.
- OAuth: PKCE S256, state nonce, non-blocking loopback with 3-min
  deadline; tokens in keyring only, travel in Authorization headers,
  never in URLs/logs.
- Project save: tmp+rename atomic; autosave isolated; recovery opt-in.
- Secrets: none embedded in the binary; client id/secret are user-owned.
- Provider error bodies surfaced verbatim but contain no credentials.

## Manual checks recommended before release (Phase 11)

- Pen-test pass on `.creatora` open with fuzzed JSON (structure is
  typed-parsed and size-capped — residual = panics in validators).
- Verify CSP doesn't break dev-mode HMR (devUrl websocket) — smoke test
  `tauri dev` once on a dev machine.
- Confirm no plugin permission creep when adding new IPC commands.

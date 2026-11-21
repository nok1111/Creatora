//! OAuth 2.0 for installed apps — RFC 8252 loopback redirect + PKCE.
//!
//! Flow: spawn a one-shot TcpListener on 127.0.0.1:0 → open the provider's
//! authorize URL in the system browser → the browser hits our loopback
//! with ?code&state → we POST the code to the token endpoint.
//!
//! Client credentials come from the USER's own developer app (configured
//! in Settings → Social). Nothing is baked into the binary — there is no
//! Creatora-owned OAuth app to abuse or leak.

use super::rules::OauthRules;
use super::vault::{self, TokenBundle};
use crate::db::Db;
use crate::error::AppError;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

const OAUTH_DONE_EVENT: &str = "social://oauth-finished";

/// PKCE verifier + challenge (S256). Verifier: 64 chars of unreserved
/// alphabet — 384 bits of entropy from two UUIDs.
pub fn pkce_pair() -> (String, String) {
    let mut v = String::with_capacity(64);
    for _ in 0..2 {
        v.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    let digest = Sha256::digest(v.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (v, challenge)
}

fn b64_state() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes())
}

/// Preferred loopback ports for the OAuth callback — keep in sync with
/// OAUTH_REDIRECT_URIS in src/lib/social-types.ts (frontend shows these
/// exact URIs for one-time registration in each dev console).
const PREFERRED_PORTS: &[u16] = &[45812, 45813, 45814];

/// What the frontend needs to render the "connect" flow.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    /// Always the loopback port actually bound — show it to the user so
    /// they can whitelist `http://127.0.0.1:{port}` in their dev console.
    pub redirect_uri: String,
    pub platform: String,
    pub scopes: Vec<String>,
}

/// Begin the flow. Returns immediately; the listener thread finishes it:
/// waits ≤3 min for the browser callback, exchanges the code, stores
/// tokens in the OS vault, inserts/updates social_accounts, and emits
/// `social://oauth-finished` {platform, accountId|error}.
#[tauri::command]
pub fn social_oauth_begin(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    platform: String,
    client_id: String,
) -> Result<OAuthStart, AppError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    let ruleset = super::rules::load(&app_data);
    let rules = ruleset
        .platforms
        .get(&platform)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown platform {platform}")))?;
    // User-configured app wins; otherwise fall back to the official app
    // shipped in the ruleset so end users just click Connect.
    let client_id = if client_id.trim().is_empty() {
        rules
            .oauth
            .client_id
            .clone()
            .ok_or_else(|| {
                AppError::InvalidInput(
                    "OAuth client id required — configure your developer app in Settings".into(),
                )
            })?
    } else {
        client_id
    };
    if !rules.capabilities.oauth_loopback {
        return Err(AppError::InvalidInput(format!(
            "{platform} does not support loopback OAuth"
        )));
    }
    let oauth = rules.oauth.clone();

    // Bind FIRST so we know the port before building the URL. Prefer a
    // deterministic loopback port set (mirrors OAUTH_REDIRECT_URIS in
    // social-types.ts): providers that require exact redirect-URI
    // registration (TikTok, Meta strict mode) then only need a one-time
    // whitelist of a known URI instead of a different one per connect.
    // Falls back to an ephemeral port if all preferred ports are busy.
    let listener = PREFERRED_PORTS
        .iter()
        .find_map(|p| TcpListener::bind(("127.0.0.1", *p)).ok())
        .or_else(|| TcpListener::bind("127.0.0.1:0").ok())
        .ok_or_else(|| AppError::Internal("loopback bind failed".into()))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("loopback addr: {e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");

    let (verifier, challenge) = pkce_pair();
    let state = b64_state();
    let mut url = format!(
        "{}?response_type=code&{}={}&redirect_uri={}&state={}&scope={}",
        oauth.auth_url,
        oauth.client_id_param,
        urlenc(&client_id),
        urlenc(&redirect_uri),
        urlenc(&state),
        urlenc(&oauth.scopes.join(" ")),
    );
    if oauth.pkce {
        url.push_str(&format!(
            "&code_challenge={}&code_challenge_method=S256",
            challenge
        ));
    }
    for (k, v) in &oauth.extra_auth_params {
        if k != "response_type" {
            url.push_str(&format!("&{}={}", k, urlenc(v)));
        }
    }

    crate::proc_ext::open_url(&url).map_err(|e| AppError::Internal(format!("open browser: {e}")))?;

    let scopes_out = oauth.scopes.clone();
    let db2 = (*db).clone();
    let app2 = app.clone();
    let platform2 = platform.clone();
    let cid = client_id.clone();
    let ruri = redirect_uri.clone();
    std::thread::spawn(move || {
        let outcome = complete_flow(
            &listener, &oauth, &state, &cid, &ruri, &verifier, &platform2,
        );
        match outcome {
            Ok(acct) => {
                let _ = persist_account(&db2, &platform2, &acct);
                let _ = app2.emit(
                    OAUTH_DONE_EVENT,
                    serde_json::json!({
                        "platform": platform2,
                        "accountId": acct.account_id,
                        "displayName": acct.display_name,
                    }),
                );
            }
            Err(e) => {
                let _ = app2.emit(
                    OAUTH_DONE_EVENT,
                    serde_json::json!({"platform": platform2, "error": e}),
                );
            }
        }
    });

    Ok(OAuthStart {
        redirect_uri,
        platform,
        scopes: scopes_out,
    })
}

struct FinishedAccount {
    account_id: String,
    platform_user_id: String,
    display_name: Option<String>,
    scopes: Vec<String>,
    token_expires_at: Option<String>,
    tokens: TokenBundle,
}

/// Block waiting for the browser redirect, then exchange the code.
fn complete_flow(
    listener: &TcpListener,
    oauth: &OauthRules,
    expect_state: &str,
    client_id: &str,
    redirect_uri: &str,
    verifier: &str,
    platform: &str,
) -> Result<FinishedAccount, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    // 3-minute window — enough for a human to finish the consent screen.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    let (mut stream, _) = loop {
        if std::time::Instant::now() > deadline {
            return Err("OAuth timed out (3 min) — try connecting again".into());
        }
        match listener.accept() {
            Ok(s) => break s,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    };

    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| e.to_string())?;
    // GET /oauth/callback?code=…&state=… HTTP/1.1
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("bad request")?;
    let params: std::collections::HashMap<String, String> = path
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .filter_map(|kv| {
            let mut it = kv.splitn(2, '=');
            Some((it.next()?.to_string(), urldec(it.next().unwrap_or(""))))
        })
        .collect();

    let reply = |s: &mut std::net::TcpStream, code: u16, body: &str| {
        let _ = s.write_all(
            format!(
                "HTTP/1.1 {code} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
    };

    if let Some(err) = params.get("error") {
        reply(
            &mut stream,
            400,
            "<h1>Authorization denied</h1><p>You can close this tab.</p>",
        );
        return Err(format!("provider returned error: {err}"));
    }
    if params.get("state").map(String::as_str) != Some(expect_state) {
        reply(&mut stream, 400, "<h1>State mismatch</h1>");
        return Err("OAuth state mismatch — possible CSRF".into());
    }
    let code = params.get("code").cloned().ok_or("no code in callback")?;
    reply(
        &mut stream,
        200,
        "<h1>Connected</h1><p>You can close this tab and return to the app.</p>",
    );

    exchange_code(oauth, &code, client_id, redirect_uri, verifier, platform)
}

/// POST the authorization code to the token endpoint → TokenBundle.
fn exchange_code(
    oauth: &OauthRules,
    code: &str,
    client_id: &str,
    redirect_uri: &str,
    verifier: &str,
    platform: &str,
) -> Result<FinishedAccount, String> {
    let client_secret = vault::load_client_secret(platform)
        .ok()
        .or_else(|| oauth.client_secret.clone());
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "authorization_code".into()),
        ("code", code.into()),
        ("redirect_uri", redirect_uri.into()),
    ];
    match oauth.client_id_param.as_str() {
        "client_key" => {
            form.push(("client_key", client_id.into()));
        }
        _ => {
            form.push(("client_id", client_id.into()));
        }
    }
    if oauth.pkce {
        form.push(("code_verifier", verifier.into()));
    }
    if let Some(s) = client_secret {
        form.push(("client_secret", s));
    }
    let resp = ureq::post(&oauth.token_url)
        .send_form(
            form.iter()
                .map(|(k, v)| (*k, v.as_str()))
                .collect::<Vec<_>>(),
        )
        .map_err(|e| format!("token exchange: {e}"))?;
    let body: serde_json::Value = resp
        .into_body()
        .read_json()
        .map_err(|e| format!("token response: {e}"))?;
    if let Some(err) = body.get("error") {
        return Err(format!("provider token error: {err}"));
    }
    let access = body["access_token"]
        .as_str()
        .ok_or("no access_token in response")?
        .to_string();
    let expires_at = body["expires_in"]
        .as_i64()
        .or_else(|| body["expires_in"].as_str().and_then(|s| s.parse().ok()))
        .map(|s| super::validate::now_unix() + s);
    let scopes = body["scope"]
        .as_str()
        .map(|s| s.split(' ').map(String::from).collect())
        .unwrap_or_else(|| oauth.scopes.clone());

    let tokens = TokenBundle {
        access_token: access.clone(),
        refresh_token: body["refresh_token"].as_str().map(str::to_string),
        expires_at,
        scopes: scopes.clone(),
        extra: body.clone(),
    };
    let (uid, name) = super::platforms::fetch_identity(platform, &access, &body)
        .unwrap_or_else(|_| (format!("{platform}-user"), None));
    Ok(FinishedAccount {
        account_id: uuid::Uuid::new_v4().to_string(),
        platform_user_id: uid,
        display_name: name,
        scopes,
        token_expires_at: expires_at.map(fmt_unix_sql),
        tokens,
    })
}

fn persist_account(db: &Arc<Db>, platform: &str, acct: &FinishedAccount) -> Result<(), AppError> {
    vault::store_tokens(&acct.account_id, &acct.tokens)?;
    db.with(|conn| {
        conn.execute(
            "INSERT INTO social_accounts(id, platform, platform_user_id,
                 display_name, scopes_json, status, token_expires_at)
             VALUES(?1,?2,?3,?4,?5,'active',?6)
             ON CONFLICT(platform, platform_user_id) DO UPDATE SET
                 id = ?1, display_name = ?4, scopes_json = ?5,
                 status = 'active', token_expires_at = ?6",
            rusqlite::params![
                acct.account_id,
                platform,
                acct.platform_user_id,
                acct.display_name,
                serde_json::to_string(&acct.scopes).unwrap(),
                acct.token_expires_at,
            ],
        )?;
        Ok(())
    })
}

pub fn fmt_unix_sql(unix: i64) -> String {
    // "YYYY-MM-DD HH:MM:SS" UTC — matches SQLite datetime('now') format.
    let days = unix.div_euclid(86400);
    let secs = unix.rem_euclid(86400);
    let (h, m, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    // civil-from-days (Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if mo <= 2 { y + 1 } else { y };
    format!("{yy:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

fn urlenc(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

fn urldec(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '%' => {
                let h: String = it.by_ref().take(2).collect();
                if let Ok(b) = u8::from_str_radix(&h, 16) {
                    out.push(b as char);
                }
            }
            '+' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Refresh an account's access token (called before API use when expired).
/// Returns the fresh access token. Updates vault + DB.
pub fn refresh_if_needed(
    db: &Arc<Db>,
    account_id: &str,
    platform: &str,
    oauth: &OauthRules,
    client_id: &str,
) -> Result<String, String> {
    let mut tokens = vault::load_tokens(account_id).map_err(|e| format!("load tokens: {e}"))?;
    if !vault::is_expired(&tokens, 300) {
        return Ok(tokens.access_token);
    }
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or("token expired and no refresh_token — reconnect the account")?;
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "refresh_token".into()),
        ("refresh_token", refresh),
    ];
    match oauth.client_id_param.as_str() {
        "client_key" => form.push(("client_key", client_id.into())),
        _ => form.push(("client_id", client_id.into())),
    }
    let refresh_secret = vault::load_client_secret(platform)
        .ok()
        .or_else(|| oauth.client_secret.clone());
    if let Some(secret) = refresh_secret {
        form.push(("client_secret", secret));
    }
    let resp = ureq::post(&oauth.token_url)
        .send_form(
            form.iter()
                .map(|(k, v)| (*k, v.as_str()))
                .collect::<Vec<_>>(),
        )
        .map_err(|e| format!("refresh: {e}"))?;
    let body: serde_json::Value = resp
        .into_body()
        .read_json()
        .map_err(|e| format!("refresh body: {e}"))?;
    let access = body["access_token"]
        .as_str()
        .ok_or("no access_token in refresh response")?
        .to_string();
    if let Some(rt) = body["refresh_token"].as_str() {
        tokens.refresh_token = Some(rt.to_string());
    }
    tokens.access_token = access.clone();
    tokens.expires_at = body["expires_in"]
        .as_i64()
        .or_else(|| body["expires_in"].as_str().and_then(|s| s.parse().ok()))
        .map(|s| super::validate::now_unix() + s);
    vault::store_tokens(account_id, &tokens).map_err(|e| format!("store: {e}"))?;
    let _ = db.with(|conn| {
        conn.execute(
            "UPDATE social_accounts SET token_expires_at=?1, status='active'
             WHERE id=?2",
            rusqlite::params![tokens.expires_at.map(fmt_unix_sql), account_id],
        )?;
        Ok(())
    });
    Ok(access)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_and_challenge_are_spec_shaped() {
        let (v, c) = pkce_pair();
        assert_eq!(v.len(), 64);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric()));
        assert!(!c.contains(['+', '/', '=']));
        assert_eq!(c.len(), 43); // S256 b64url
    }

    #[test]
    fn urlenc_roundtrip() {
        let s = "a b+c/d&e=f%";
        assert_eq!(urldec(&urlenc(s)), s);
    }

    #[test]
    fn fmt_unix_sql_epoch() {
        assert_eq!(fmt_unix_sql(0), "1970-01-01 00:00:00");
        assert_eq!(fmt_unix_sql(1_700_000_000), "2023-11-14 22:13:20");
    }
}

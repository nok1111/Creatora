//! Manual analytics import (Phase 9): CSV / JSON files → metric
//! snapshots with source='import'. Never overwrites existing data —
//! the dedupe index skips rows that already exist for the same
//! (target, period, source, day).
//!
//! Format contract (documented for users):
//!   Required columns: platform, remote_id | post_url
//!   Optional:         period (default 'lifetime'), date/fetched_at,
//!                     title (cosmetic)
//!   Metric columns:   views, impressions, reach, likes, comments,
//!                     shares, saves, watch_time_minutes,
//!                     avg_view_duration_sec, followers_gained
//! JSON variant: an array of objects with the same keys.
//!
//! Safety: ≤10 MiB files, ≤50k rows, no eval, everything quoted through
//! params! — imported text can never reach SQL or the shell.

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

const MAX_BYTES: u64 = 10 << 20;
const MAX_ROWS: usize = 50_000;

const METRIC_KEYS: &[(&str, &str, &str)] = &[
    ("views", "Views", "count"),
    ("impressions", "Impressions", "count"),
    ("reach", "Reach", "count"),
    ("likes", "Likes", "count"),
    ("comments", "Comments", "count"),
    ("shares", "Shares", "count"),
    ("saves", "Saves", "count"),
    ("watch_time_minutes", "Watch time", "minutes"),
    ("avg_view_duration_sec", "Avg view duration", "seconds"),
    ("followers_gained", "Followers gained", "count"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub platform: String,
    pub remote_id: String,
    pub period: String,
    pub date: Option<String>,
    pub title: Option<String>,
    pub metrics: Vec<(String, f64)>,
    /// matched social_post_targets.id when the remote id is known
    pub target_id: Option<String>,
    pub issue: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub format: String,
    pub rows_seen: usize,
    pub rows: Vec<ImportRow>,
    pub columns: Vec<String>,
    pub matched: usize,
    pub unmatched: usize,
    pub issues: Vec<String>,
}

// ---------------------------------------------------------------- CSV

/// RFC-4180-ish CSV: quoted fields, "" escapes, CRLF/LF.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => in_quotes = false,
                _ => field.push(c),
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                }
                '\n' | '\r' => {
                    if c == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    row.push(std::mem::take(&mut field));
                    if !row.iter().all(|f| f.is_empty()) {
                        rows.push(std::mem::take(&mut row));
                    }
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn norm_header(h: &str) -> String {
    h.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn row_from_map(
    m: &serde_json::Map<String, serde_json::Value>,
    db: &Arc<Db>,
) -> Result<ImportRow, String> {
    let get_s = |k: &str| -> Option<String> {
        m.get(k)
            .and_then(|v| {
                v.as_str()
                    .map(str::to_string)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let platform = get_s("platform").ok_or("missing platform")?.to_lowercase();
    if !super::model::PLATFORMS.contains(&platform.as_str()) {
        return Err(format!("unknown platform '{platform}'"));
    }
    let remote_id = get_s("remote_id").or_else(|| {
        get_s("post_url").and_then(|u| {
            u.rsplit(['/', '='])
                .find(|s| !s.is_empty())
                .map(str::to_string)
        })
    });
    let remote_id = remote_id.ok_or("missing remote_id / post_url")?;
    let period = get_s("period").unwrap_or_else(|| "lifetime".into());
    let date = get_s("date").or_else(|| get_s("fetched_at"));
    let title = get_s("title");
    let mut metrics = Vec::new();
    for (key, _, _) in METRIC_KEYS {
        if let Some(v) = m.get(*key).and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        }) {
            metrics.push((key.to_string(), v));
        }
    }
    if metrics.is_empty() {
        return Err("no metric columns with values".into());
    }
    let target_id = find_target(db, &platform, &remote_id);
    Ok(ImportRow {
        platform,
        remote_id,
        period,
        date,
        title,
        metrics,
        target_id,
        issue: None,
    })
}

fn find_target(db: &Arc<Db>, platform: &str, remote_id: &str) -> Option<String> {
    db.with(|c| -> Result<Option<String>, AppError> {
        Ok(c.query_row(
            "SELECT id FROM social_post_targets
                 WHERE platform=?1 AND platform_post_id=?2 LIMIT 1",
            params![platform, remote_id],
            |r| r.get(0),
        )
        .ok())
    })
    .ok()
    .flatten()
}

type LoadedRows = (String, Vec<String>, Vec<Result<ImportRow, String>>);

fn load_rows(path: &std::path::Path, db: &Arc<Db>) -> Result<LoadedRows, AppError> {
    let size = std::fs::metadata(path)
        .map_err(|e| AppError::InvalidInput(format!("read file: {e}")))?
        .len();
    if size > MAX_BYTES {
        return Err(AppError::InvalidInput("file over 10 MiB".into()));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| AppError::InvalidInput(format!("read file: {e}")))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "json" {
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::InvalidInput(format!("invalid JSON: {e}")))?;
        let arr = v
            .as_array()
            .ok_or_else(|| AppError::InvalidInput("JSON must be an array of rows".into()))?;
        if arr.len() > MAX_ROWS {
            return Err(AppError::InvalidInput("over 50k rows".into()));
        }
        let rows: Vec<_> = arr
            .iter()
            .map(|v| {
                v.as_object()
                    .ok_or_else(|| "row is not an object".to_string())
                    .and_then(|m| row_from_map(m, db))
            })
            .collect();
        Ok(("json".into(), vec![], rows))
    } else if ext == "csv" {
        let rows = parse_csv(&text);
        if rows.is_empty() {
            return Err(AppError::InvalidInput("empty CSV".into()));
        }
        if rows.len() > MAX_ROWS {
            return Err(AppError::InvalidInput("over 50k rows".into()));
        }
        let headers: Vec<String> = rows[0].iter().map(|h| norm_header(h)).collect();
        let out: Vec<_> = rows[1..]
            .iter()
            .map(|r| {
                let mut m = serde_json::Map::new();
                for (i, h) in headers.iter().enumerate() {
                    if let Some(v) = r.get(i) {
                        m.insert(h.clone(), serde_json::Value::String(v.clone()));
                    }
                }
                row_from_map(&m, db)
            })
            .collect();
        Ok(("csv".into(), headers, out))
    } else {
        Err(AppError::InvalidInput(
            "unsupported format — use .csv or .json".into(),
        ))
    }
}

/// Parse + validate + match targets. No writes.
pub fn preview_import(db: &Arc<Db>, path: &str) -> CmdResult<ImportPreview> {
    let (format, columns, parsed) = load_rows(std::path::Path::new(path), db)?;
    let mut rows = Vec::with_capacity(parsed.len());
    let mut issues = Vec::new();
    for (i, r) in parsed.into_iter().enumerate() {
        match r {
            Ok(row) => rows.push(row),
            Err(e) => issues.push(format!("row {}: {e}", i + 2)),
        }
    }
    let matched = rows.iter().filter(|r| r.target_id.is_some()).count();
    Ok(ImportPreview {
        format,
        rows_seen: rows.len() + issues.len(),
        matched,
        unmatched: rows.len() - matched,
        rows,
        columns,
        issues,
    })
}

/// Commit the previewed file: insert snapshots (source='import'),
/// skip duplicates, record the batch. Never overwrites — the dedupe
/// index turns re-imports into skips, not clobbers.
#[tauri::command]
pub fn analytics_import_preview(db: State<'_, Arc<Db>>, path: String) -> CmdResult<ImportPreview> {
    preview_import(&db, &path)
}

/// Commit core (shared by the command and tests).
pub fn commit_import(db: &Arc<Db>, path: &str, source_label: &str) -> CmdResult<serde_json::Value> {
    let filename = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let (format, _cols, parsed) = load_rows(std::path::Path::new(path), db)?;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let mut imported = 0i64;
    let mut skipped = 0i64;
    let mut errors: Vec<String> = Vec::new();
    let mut rows_seen = 0i64;

    for (i, r) in parsed.iter().enumerate() {
        rows_seen += 1;
        match r {
            Err(e) => {
                skipped += 1;
                errors.push(format!("row {}: {e}", i + 2));
            }
            Ok(row) => {
                let Some(target_id) = &row.target_id else {
                    skipped += 1;
                    errors.push(format!(
                        "row {}: {} — no matching target for {}/{}",
                        i + 2,
                        "unmatched",
                        row.platform,
                        row.remote_id
                    ));
                    continue;
                };
                let metrics = serde_json::json!({
                    "metrics": row.metrics.iter().map(|(k, v)| {
                        let (_, label, unit) = METRIC_KEYS
                            .iter()
                            .find(|(key, _, _)| key == k)
                            .copied()
                            .unwrap_or(("", k.as_str(), "count"));
                        serde_json::json!({"key": k, "label": label, "unit": unit, "value": v})
                    }).collect::<Vec<_>>(),
                    "unavailable": [],
                })
                .to_string();
                let res = db.with(|c| -> Result<usize, AppError> {
                    let r = if let Some(date) = &row.date {
                        c.execute(
                            "INSERT OR IGNORE INTO metric_snapshots
                             (id,target_id,platform,remote_id,period,source,fetched_at,batch_id,metrics_json)
                             VALUES(?1,?2,?3,?4,?5,'import',?6,?7,?8)",
                            params![
                                uuid::Uuid::new_v4().to_string(),
                                target_id,
                                row.platform,
                                row.remote_id,
                                row.period,
                                date,
                                batch_id,
                                metrics
                            ],
                        )
                    } else {
                        c.execute(
                            "INSERT OR IGNORE INTO metric_snapshots
                             (id,target_id,platform,remote_id,period,source,batch_id,metrics_json)
                             VALUES(?1,?2,?3,?4,?5,'import',?6,?7)",
                            params![
                                uuid::Uuid::new_v4().to_string(),
                                target_id,
                                row.platform,
                                row.remote_id,
                                row.period,
                                batch_id,
                                metrics
                            ],
                        )
                    };
                    r.map_err(AppError::from)
                });
                match res {
                    Ok(0) => skipped += 1, // dedupe index fired
                    Ok(_) => imported += 1,
                    Err(e) => {
                        skipped += 1;
                        errors.push(format!("row {}: {e}", i + 2));
                    }
                }
            }
        }
    }

    db.with(|c| {
        c.execute(
            "INSERT INTO import_batches(id,filename,format,source_label,
                rows_seen,rows_imported,rows_skipped,errors_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                batch_id,
                filename,
                format,
                source_label,
                rows_seen,
                imported,
                skipped,
                serde_json::to_string(&errors).unwrap_or_default()
            ],
        )?;
        Ok(())
    })?;
    Ok(serde_json::json!({
        "batchId": batch_id,
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }))
}

#[tauri::command]
pub fn analytics_import_commit(
    db: State<'_, Arc<Db>>,
    path: String,
    source_label: String,
) -> CmdResult<serde_json::Value> {
    commit_import(&db, &path, &source_label)
}

/// List past imports (the audit trail).
#[tauri::command]
pub fn analytics_import_batches(db: State<'_, Arc<Db>>) -> CmdResult<Vec<serde_json::Value>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,filename,format,source_label,rows_seen,rows_imported,rows_skipped,created_at
             FROM import_batches ORDER BY created_at DESC LIMIT 50",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "filename": r.get::<_, String>(1)?,
                    "format": r.get::<_, String>(2)?,
                    "sourceLabel": r.get::<_, String>(3)?,
                    "rowsSeen": r.get::<_, i64>(4)?,
                    "rowsImported": r.get::<_, i64>(5)?,
                    "rowsSkipped": r.get::<_, i64>(6)?,
                    "createdAt": r.get::<_, String>(7)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

//! Analytics engine (Phase 9, ADR-029): snapshot sync from platform
//! stats adapters, history queries, local insights and comparison.
//!
//! Design rules:
//! - Every metric row carries `source` (api|import|local) — the UI
//!   always knows where a number came from.
//! - Snapshots are append-only; same-day re-sync updates the day's row
//!   (UNIQUE index) instead of spamming history.
//! - Sync is a job: dedupe by freshness window, 401 → one refresh +
//!   retry, 429 → honor Retry-After, everything recorded in
//!   analytics_sync_runs / analytics_sync_errors.
//! - Insights are LOCAL computations over stored snapshots — they work
//!   offline and always report sample size.

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::JobManager;
use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;
use tauri::{Manager, State};

use super::stats::{self, StatsResult};

// ---------------------------------------------------------------- types

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    pub id: String,
    pub target_id: String,
    pub platform: String,
    pub remote_id: Option<String>,
    pub period: String,
    pub source: String,
    pub fetched_at: String,
    pub metrics: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunRow {
    pub id: String,
    pub trigger_kind: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub targets_total: i64,
    pub targets_ok: i64,
    pub targets_failed: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    /// stable key for i18n / testing
    pub kind: String,
    pub title: String,
    pub detail: String,
    /// human-readable evidence: n posts, which metric, what period
    pub evidence: String,
    pub sample_size: i64,
    /// always present — honesty about correlation vs causation
    pub caveat: String,
}

// ---------------------------------------------------------------- sync

const SYNC_INTERVAL_KEY: &str = "analytics.sync_interval_minutes";
const SYNC_LAST_RUN_KEY: &str = "analytics.last_run_unix";

/// Configured auto-sync interval in minutes (0 = off).
pub fn sync_interval_minutes(db: &Arc<Db>) -> i64 {
    db.with(|c| -> Result<i64, AppError> {
        let v: String = c.query_row(
            "SELECT value FROM settings WHERE key=?1",
            [SYNC_INTERVAL_KEY],
            |r| r.get(0),
        )?;
        Ok(v.parse().unwrap_or(0))
    })
    .unwrap_or(0)
}

/// Called by the scheduler tick — starts a scheduled run when due.
pub fn maybe_run_due(app: &tauri::AppHandle, jobs: &JobManager, db: &Arc<Db>) {
    let interval = sync_interval_minutes(db);
    if interval <= 0 {
        return;
    }
    let last = db
        .with(|c| -> Result<i64, AppError> {
            let v: String = c.query_row(
                "SELECT value FROM settings WHERE key=?1",
                [SYNC_LAST_RUN_KEY],
                |r| r.get(0),
            )?;
            Ok(v.parse().unwrap_or(0))
        })
        .unwrap_or(0);
    let now = super::validate::now_unix();
    if now - last < interval * 60 {
        return;
    }
    let _ = db.with(|c| {
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![SYNC_LAST_RUN_KEY, now.to_string()],
        )?;
        Ok::<(), AppError>(())
    });
    start_sync_job(app.clone(), jobs, db.clone(), None, "scheduled".into());
}

type SyncTarget = (String, String, String, String, serde_json::Value);
type SnapRow = (
    String,
    String,
    serde_json::Value,
    Option<String>,
    String,
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

/// Targets eligible for stats sync: published + remote id + account.
fn syncable_targets(db: &Arc<Db>, only: Option<&str>) -> Result<Vec<SyncTarget>, AppError> {
    db.with(|conn| {
        let base = "SELECT t.id, t.platform, t.platform_post_id, t.account_id,
                           t.platform_meta_json
                    FROM social_post_targets t
                    WHERE t.status='published' AND t.platform_post_id IS NOT NULL
                      AND t.account_id IS NOT NULL";
        let (sql, args): (String, Vec<String>) = match only {
            Some(id) => (format!("{base} AND t.id=?1"), vec![id.to_string()]),
            None => (base.to_string(), vec![]),
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(id, p, rid, acc, mj)| {
                (
                    id,
                    p,
                    rid,
                    acc,
                    serde_json::from_str(&mj).unwrap_or_default(),
                )
            })
            .collect())
    })
}

/// Freshness: was there an 'api' snapshot for this target within the
/// last `fresh_secs`? Scheduled runs skip fresh targets — no spam.
fn recently_synced(db: &Arc<Db>, target_id: &str, fresh_secs: i64) -> bool {
    db.with(|c| -> Result<bool, AppError> {
        match c.query_row(
            "SELECT 1 FROM metric_snapshots
             WHERE target_id=?1 AND source='api'
               AND fetched_at >= datetime('now', ?2)
             LIMIT 1",
            params![target_id, format!("-{fresh_secs} seconds")],
            |_| Ok(()),
        ) {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(AppError::from(e)),
        }
    })
    .unwrap_or(false)
}

fn store_snapshot(
    db: &Arc<Db>,
    target_id: &str,
    platform: &str,
    remote_id: &str,
    result: &StatsResult,
) -> Result<(), AppError> {
    // metrics_json carries BOTH lists so history keeps what the API
    // could not serve — "no data" is itself data.
    let full = serde_json::json!({
        "metrics": result.metrics,
        "unavailable": result.unavailable,
    })
    .to_string();
    db.with(|c| {
        c.execute(
            "INSERT INTO metric_snapshots(id,target_id,platform,remote_id,
                period,source,metrics_json)
             VALUES(?1,?2,?3,?4,'lifetime','api',?5)
             ON CONFLICT(target_id,period,source,date(fetched_at))
             DO UPDATE SET metrics_json=excluded.metrics_json,
                           remote_id=excluded.remote_id,
                           fetched_at=datetime('now')",
            params![
                uuid::Uuid::new_v4().to_string(),
                target_id,
                platform,
                remote_id,
                full
            ],
        )?;
        Ok::<(), AppError>(())
    })
}

fn oauth_cfg(
    db: &Arc<Db>,
    app_data: &std::path::Path,
    platform: &str,
) -> Result<(super::rules::OauthRules, String), String> {
    let ruleset = super::rules::load(app_data);
    let rules = ruleset
        .platforms
        .get(platform)
        .ok_or_else(|| format!("no rules for {platform}"))?;
    let client_id: String = db
        .with(|c| {
            c.query_row(
                "SELECT value FROM settings WHERE key=?1",
                [format!("oauth_client_id.{platform}")],
                |r| r.get(0),
            )
            .map_err(AppError::from)
        })
        .map_err(|e| e.to_string())?;
    Ok((rules.oauth.clone(), client_id))
}

fn start_sync_job(
    app: tauri::AppHandle,
    jobs: &JobManager,
    db: Arc<Db>,
    only: Option<String>,
    trigger_kind: String,
) -> String {
    let app_data = app.path().app_data_dir().ok();
    jobs.spawn(app, "social.analytics.sync", move |ctx| {
        let run_id = uuid::Uuid::new_v4().to_string();
        let app_data = app_data.ok_or_else(|| "no app_data_dir".to_string())?;
        let targets = syncable_targets(&db, only.as_deref()).map_err(|e| e.to_string())?;
        let total = targets.len() as i64;
        db.with(|c| {
            c.execute(
                "INSERT INTO analytics_sync_runs(id,trigger_kind,targets_total)
                 VALUES(?1,?2,?3)",
                params![run_id, trigger_kind, total],
            )?;
            Ok::<(), AppError>(())
        })
        .map_err(|e| e.to_string())?;

        let mut ok = 0i64;
        let mut failed = 0i64;
        let mut global_backoff = 0u64;
        for (i, (tid, platform, remote_id, account_id, meta)) in targets.iter().enumerate() {
            if ctx.is_cancelled() {
                let _ = db.with(|c| {
            c.execute(
                        "UPDATE analytics_sync_runs SET status='cancelled',
                         finished_at=datetime('now') WHERE id=?1",
                        [&run_id],
                    )?;
            Ok::<(), AppError>(())
        });
                return Err("cancelled".into());
            }
            ctx.progress(i as f32 / total.max(1) as f32, Some("Syncing stats"));
            // Freshness dedupe — skip targets synced < 30 min ago on
            // scheduled runs (manual sync always runs).
            if trigger_kind == "scheduled" && recently_synced(&db, tid, 1800) {
                ok += 1;
                continue;
            }
            if global_backoff > 0 {
                std::thread::sleep(std::time::Duration::from_secs(global_backoff.min(60)));
                global_backoff = 0;
            }
            let result = (|| -> Result<StatsResult, String> {
                let (oauth, client_id) = oauth_cfg(&db, &app_data, platform)?;
                let token = super::oauth::refresh_if_needed(
                    &db, account_id, platform, &oauth, &client_id,
                )?;
                match stats::fetch_stats(platform, &token, remote_id, meta) {
                    Ok(r) => Ok(r),
                    Err(e) if e.is_unauthorized() => {
                        // Token rejected despite expiry check → one
                        // forced refresh attempt, then give up honestly.
                        let token2 = super::oauth::refresh_if_needed(
                            &db, account_id, platform, &oauth, &client_id,
                        )?;
                        stats::fetch_stats(platform, &token2, remote_id, meta)
                            .map_err(|e2| e2.to_message())
                    }
                    Err(e) if e.is_rate_limited() => {
                        global_backoff = e.retry_after.unwrap_or(30);
                        Err(format!(
                            "rate limited (retry after {}s)",
                            e.retry_after.unwrap_or(30)
                        ))
                    }
                    Err(e) => Err(e.to_message()),
                }
            })();
            match result {
                Ok(stats) => {
                    if let Err(e) = store_snapshot(&db, tid, platform, remote_id, &stats) {
                        failed += 1;
                        let _ = db.with(|c| {
            c.execute(
                                "INSERT INTO analytics_sync_errors(id,run_id,target_id,platform,error)
                                 VALUES(?1,?2,?3,?4,?5)",
                                params![
                                    uuid::Uuid::new_v4().to_string(),
                                    run_id,
                                    tid,
                                    platform,
                                    e.to_string()
                                ],
                            )?;
            Ok::<(), AppError>(())
        });
                    } else {
                        ok += 1;
                    }
                }
                Err(e) => {
                    failed += 1;
                    let _ = db.with(|c| {
            c.execute(
                            "INSERT INTO analytics_sync_errors(id,run_id,target_id,platform,error)
                             VALUES(?1,?2,?3,?4,?5)",
                            params![uuid::Uuid::new_v4().to_string(), run_id, tid, platform, e],
                        )?;
            Ok::<(), AppError>(())
        });
                }
            }
        }
        // Account-level metrics (followers etc.) — once per distinct
        // account touched this run. Dedupe is per-day via the unique
        // index, so repeated syncs stay idempotent; a failure here is
        // recorded as a sync error, never silently skipped.
        let accounts: std::collections::HashSet<(String, String)> = targets
            .iter()
            .map(|(_, platform, _, account_id, _)| (platform.clone(), account_id.clone()))
            .collect();
        for (platform, account_id) in accounts {
            if ctx.is_cancelled() {
                break;
            }
            let acct = (|| -> Result<(), String> {
                let (uid, meta) = db.with(|c| {
                    c.query_row(
                        "SELECT platform_user_id, meta_json FROM social_accounts WHERE id=?1",
                        [&account_id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .map_err(Into::into)
                })
                .map_err(|e: AppError| e.to_string())?;
                let meta: serde_json::Value =
                    serde_json::from_str(&meta).unwrap_or_default();
                let (oauth, client_id) = oauth_cfg(&db, &app_data, &platform)?;
                let token = super::oauth::refresh_if_needed(
                    &db, &account_id, &platform, &oauth, &client_id,
                )?;
                let res = stats::fetch_account_stats(&platform, &token, &uid, &meta)
                    .map_err(|e| e.to_message())?;
                if res.metrics.is_empty() {
                    return Ok(());
                }
                let mj = serde_json::to_string(&res.metrics)
                    .unwrap_or_else(|_| "[]".into());
                db.with(|c| {
                    c.execute(
                        "INSERT OR IGNORE INTO account_snapshots
                         (id,account_id,platform,source,metrics_json)
                         VALUES(?1,?2,?3,'api',?4)",
                        rusqlite::params![uuid::Uuid::new_v4().to_string(), account_id, platform, mj],
                    )?;
                    Ok::<(), AppError>(())
                })
                .map_err(|e: AppError| e.to_string())?;
                Ok(())
            })();
            if let Err(e) = acct {
                let _ = db.with(|c| {
                    c.execute(
                        "INSERT INTO analytics_sync_errors(id,run_id,target_id,platform,error)
                         VALUES(?1,?2,NULL,?3,?4)",
                        rusqlite::params![uuid::Uuid::new_v4().to_string(), run_id, platform,
                            format!("account stats: {e}")],
                    )?;
                    Ok::<(), AppError>(())
                });
            }
        }

        let status = if failed == 0 {
            "ok"
        } else if ok == 0 && total > 0 {
            "failed"
        } else {
            "partial"
        };
        db.with(|c| {
            c.execute(
                "UPDATE analytics_sync_runs SET status=?1, finished_at=datetime('now'),
                 targets_ok=?2, targets_failed=?3 WHERE id=?4",
                params![status, ok, failed, run_id],
            )?;
            Ok::<(), AppError>(())
        })
        .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({"runId": run_id, "ok": ok, "failed": failed}))
    })
}

// ---------------------------------------------------------------- commands

/// Start a stats sync job. `target_id=None` → all published targets.
#[tauri::command]
pub fn analytics_sync(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    target_id: Option<String>,
) -> CmdResult<String> {
    Ok(start_sync_job(
        app,
        &jobs,
        (*db).clone(),
        target_id,
        "manual".into(),
    ))
}

/// Recent sync runs with their errors.
#[tauri::command]
pub fn analytics_sync_runs(
    db: State<'_, Arc<Db>>,
    limit: Option<i64>,
) -> CmdResult<Vec<SyncRunRow>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,trigger_kind,started_at,finished_at,status,
                    targets_total,targets_ok,targets_failed
             FROM analytics_sync_runs ORDER BY started_at DESC LIMIT ?1",
        )?;
        let runs = stmt
            .query_map([limit.unwrap_or(20)], |r| {
                Ok(SyncRunRow {
                    id: r.get(0)?,
                    trigger_kind: r.get(1)?,
                    started_at: r.get(2)?,
                    finished_at: r.get(3)?,
                    status: r.get(4)?,
                    targets_total: r.get(5)?,
                    targets_ok: r.get(6)?,
                    targets_failed: r.get(7)?,
                    errors: vec![],
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(runs.len());
        let mut es = conn.prepare(
            "SELECT platform, error FROM analytics_sync_errors WHERE run_id=?1 ORDER BY created_at",
        )?;
        for mut run in runs {
            run.errors = es
                .query_map([&run.id], |r| {
                    Ok(format!(
                        "{}: {}",
                        r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        r.get::<_, String>(1)?
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            out.push(run);
        }
        Ok(out)
    })
}

/// Sync settings + state for the Sync Manager UI.
#[tauri::command]
pub fn analytics_sync_status(db: State<'_, Arc<Db>>) -> CmdResult<serde_json::Value> {
    let interval = sync_interval_minutes(&db);
    let last: Option<String> = db.with(|c| -> Result<Option<String>, AppError> {
        Ok(c.query_row(
            "SELECT finished_at FROM analytics_sync_runs
             ORDER BY started_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok())
    })?;
    let eligible: i64 = db.with(|c| {
        Ok(c.query_row(
            "SELECT COUNT(*) FROM social_post_targets
             WHERE status='published' AND platform_post_id IS NOT NULL
               AND account_id IS NOT NULL",
            [],
            |r| r.get(0),
        )?)
    })?;
    Ok(serde_json::json!({
        "intervalMinutes": interval,
        "lastFinishedAt": last,
        "syncableTargets": eligible,
    }))
}

#[tauri::command]
pub fn analytics_set_sync_interval(db: State<'_, Arc<Db>>, minutes: i64) -> CmdResult<()> {
    if !(0..=10080).contains(&minutes) {
        return Err(AppError::InvalidInput("interval 0..10080 min".into()));
    }
    db.with(|c| {
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![SYNC_INTERVAL_KEY, minutes.to_string()],
        )?;
        Ok::<(), AppError>(())
    })
}

// ---------------------------------------------------------------- queries

fn row_to_snapshot(r: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotRow> {
    let mj: String = r.get(7)?;
    Ok(SnapshotRow {
        id: r.get(0)?,
        target_id: r.get(1)?,
        platform: r.get(2)?,
        remote_id: r.get(3)?,
        period: r.get(4)?,
        source: r.get(5)?,
        fetched_at: r.get(6)?,
        metrics: serde_json::from_str(&mj).unwrap_or_default(),
    })
}

/// Snapshot history for one target — post detail "evolución histórica".
#[tauri::command]
pub fn analytics_target_history(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> CmdResult<Vec<SnapshotRow>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,target_id,platform,remote_id,period,source,fetched_at,metrics_json
             FROM metric_snapshots WHERE target_id=?1
             ORDER BY fetched_at ASC LIMIT 500",
        )?;
        let rows = stmt
            .query_map([&target_id], row_to_snapshot)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Dashboard aggregate — newest snapshot per target in window. Rows
/// stay per-platform: different platforms never share metric buckets
/// (a YouTube "view" is not a TikTok "play").
#[tauri::command]
pub fn analytics_dashboard(
    db: State<'_, Arc<Db>>,
    window_days: Option<i64>,
    platform: Option<String>,
) -> CmdResult<serde_json::Value> {
    let days = window_days.unwrap_or(30).clamp(1, 3650);
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT s.target_id, s.platform, s.remote_id, s.source,
                    s.fetched_at, s.metrics_json,
                    t.published_at, p.title,
                    a.duration_ms, a.width, a.height, t.version_id
             FROM metric_snapshots s
             JOIN social_post_targets t ON t.id=s.target_id
             JOIN social_posts p ON p.id=t.post_id
             LEFT JOIN media_assets a ON a.id=t.export_asset_id
             WHERE s.fetched_at >= datetime('now', ?1)
               AND (?2 IS NULL OR s.platform=?2)
             ORDER BY s.fetched_at DESC",
        )?;
        let rows = stmt
            .query_map(params![format!("-{days} days"), platform], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                    r.get::<_, Option<i64>>(10)?,
                    r.get::<_, Option<String>>(11)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut seen = std::collections::HashSet::new();
        let mut posts = Vec::new();
        for (tid, plat, rid, source, fat, mj, pub_at, title, dur, w, h, ver) in rows {
            if !seen.insert(tid.clone()) {
                continue;
            }
            let metrics = serde_json::from_str::<serde_json::Value>(&mj).unwrap_or_default();
            posts.push(serde_json::json!({
                "targetId": tid, "platform": plat, "remoteId": rid,
                "source": source, "fetchedAt": fat,
                "publishedAt": pub_at, "title": title,
                "durationMs": dur, "width": w, "height": h,
                "versionId": ver,
                "metrics": metrics,
            }));
        }
        Ok(serde_json::json!({"windowDays": days, "posts": posts}))
    })
}

/// Compare a set of targets — latest snapshot each, normalized to a
/// metric-key table. Only metric keys present in ≥1 selected row are
/// returned; per-row missing values are null (shown as n/a, never 0).
#[tauri::command]
pub fn analytics_compare(
    db: State<'_, Arc<Db>>,
    target_ids: Vec<String>,
) -> CmdResult<serde_json::Value> {
    if target_ids.len() > 20 {
        return Err(AppError::InvalidInput("compare up to 20 posts".into()));
    }
    db.with(|conn| {
        let mut cols = std::collections::BTreeSet::<String>::new();
        let mut rows = Vec::new();
        for tid in &target_ids {
            let row = conn
                .query_row(
                    "SELECT s.platform,s.remote_id,s.source,s.fetched_at,s.metrics_json,
                            p.title,t.published_at,a.duration_ms
                     FROM metric_snapshots s
                     JOIN social_post_targets t ON t.id=s.target_id
                     JOIN social_posts p ON p.id=t.post_id
                     LEFT JOIN media_assets a ON a.id=t.export_asset_id
                     WHERE s.target_id=?1 ORDER BY s.fetched_at DESC LIMIT 1",
                    [tid],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, Option<String>>(6)?,
                            r.get::<_, Option<i64>>(7)?,
                        ))
                    },
                )
                .ok();
            let Some((plat, rid, source, fat, mj, title, pub_at, dur)) = row else {
                rows.push(serde_json::json!({
                    "targetId": tid, "metrics": {}, "noData": true,
                }));
                continue;
            };
            let parsed = serde_json::from_str::<serde_json::Value>(&mj).unwrap_or_default();
            let mut mm = serde_json::Map::new();
            if let Some(arr) = parsed["metrics"].as_array() {
                for m in arr {
                    let k = m["key"].as_str().unwrap_or("").to_string();
                    if !k.is_empty() {
                        cols.insert(k.clone());
                        mm.insert(k, m["value"].clone());
                    }
                }
            }
            rows.push(serde_json::json!({
                "targetId": tid, "platform": plat, "remoteId": rid,
                "source": source, "fetchedAt": fat, "title": title,
                "publishedAt": pub_at, "durationMs": dur,
                "metrics": serde_json::Value::Object(mm),
                "unavailable": parsed["unavailable"],
            }));
        }
        Ok(serde_json::json!({
            "metricKeys": cols.into_iter().collect::<Vec<_>>(),
            "rows": rows,
        }))
    })
}

// ---------------------------------------------------------------- insights

/// Local insights over stored snapshots — every claim carries its
/// sample size and a correlation-not-causation caveat. Pure reads,
/// works fully offline.
#[tauri::command]
pub fn analytics_insights(
    db: State<'_, Arc<Db>>,
    window_days: Option<i64>,
) -> CmdResult<Vec<Insight>> {
    let days = window_days.unwrap_or(90).clamp(1, 3650);
    let caveat = "Correlation, not causation — treat as a hypothesis to test, not a rule.";
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT s.target_id, s.platform, s.metrics_json,
                    t.published_at, p.title, a.duration_ms, a.width, a.height,
                    s.fetched_at
             FROM metric_snapshots s
             JOIN social_post_targets t ON t.id=s.target_id
             JOIN social_posts p ON p.id=t.post_id
             LEFT JOIN media_assets a ON a.id=t.export_asset_id
             WHERE s.fetched_at >= datetime('now', ?1)
             ORDER BY s.fetched_at DESC",
        )?;
        let rows = stmt
            .query_map([format!("-{days} days")], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // Newest snapshot per target (rows come DESC by fetched_at).
        let mut seen = std::collections::HashSet::new();
        let mut data: Vec<SnapRow> = Vec::new();
        for row in rows {
            if seen.insert(row.0.clone()) {
                let mj = serde_json::from_str(&row.2).unwrap_or_default();
                data.push((row.0, row.1, mj, row.3, row.4, row.5, row.6, row.7));
            }
        }
        let metric = |m: &serde_json::Value, key: &str| -> Option<f64> {
            m["metrics"]
                .as_array()?
                .iter()
                .find(|x| x["key"].as_str() == Some(key))
                .and_then(|x| x["value"].as_f64())
        };
        let mut out: Vec<Insight> = Vec::new();

        // 1) Top post per platform by views.
        let mut by_plat: std::collections::HashMap<String, Vec<(f64, &str)>> =
            std::collections::HashMap::new();
        for (_, plat, m, _, title, _, _, _) in &data {
            if let Some(v) = metric(m, "views") {
                by_plat.entry(plat.clone()).or_default().push((v, title));
            }
        }
        for (plat, mut tops) in by_plat {
            tops.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            if let Some((v, t)) = tops.first() {
                out.push(Insight {
                    kind: "top_views".into(),
                    title: format!("Top {plat} post by views"),
                    detail: format!("“{t}” leads with {v:.0} views."),
                    evidence: format!(
                        "n={} published {plat} posts with views data",
                        tops.len()
                    ),
                    sample_size: tops.len() as i64,
                    caveat: caveat.into(),
                });
            }
        }

        // 2) Duration vs views — split at the median duration.
        let mut with_dur: Vec<(i64, f64)> = data
            .iter()
            .filter_map(|(_, _, m, _, _, d, _, _)| {
                d.and_then(|d| metric(m, "views").map(|v| (d, v)))
            })
            .collect();
        if with_dur.len() >= 4 {
            with_dur.sort_by_key(|(d, _)| *d);
            let mid = with_dur.len() / 2;
            let short_avg = with_dur[..mid].iter().map(|(_, v)| v).sum::<f64>() / mid as f64;
            let long_avg = with_dur[mid..].iter().map(|(_, v)| v).sum::<f64>()
                / (with_dur.len() - mid) as f64;
            let median_s = with_dur[mid].0 as f64 / 1000.0;
            let winner = if short_avg >= long_avg { "shorter" } else { "longer" };
            out.push(Insight {
                kind: "duration_vs_views".into(),
                title: format!("{winner} videos trend higher on views"),
                detail: format!(
                    "Posts ≤{median_s:.0}s average {short_avg:.0} views vs {long_avg:.0} above it."
                ),
                evidence: format!("n={} posts with duration+views", with_dur.len()),
                sample_size: with_dur.len() as i64,
                caveat: format!("{caveat} Duration likely proxies for content type or platform."),
            });
        }

        // 3) Publish hour vs views.
        let mut by_hour: std::collections::HashMap<u32, Vec<f64>> =
            std::collections::HashMap::new();
        for (_, _, m, pub_at, _, _, _, _) in &data {
            if let (Some(pa), Some(v)) = (pub_at, metric(m, "views")) {
                let hour: u32 = pa.get(11..13).and_then(|s| s.parse().ok()).unwrap_or(0);
                by_hour.entry(hour).or_default().push(v);
            }
        }
        let total_posts: usize = by_hour.values().map(|v| v.len()).sum();
        if total_posts >= 6 && by_hour.len() >= 3 {
            let mut best = (0u32, 0f64, 0usize);
            for (h, vs) in &by_hour {
                let avg = vs.iter().sum::<f64>() / vs.len() as f64;
                if avg > best.1 {
                    best = (*h, avg, vs.len());
                }
            }
            out.push(Insight {
                kind: "publish_hour".into(),
                title: format!("Posts published around {:02}:00 trend highest", best.0),
                detail: format!(
                    "Avg {:.0} views for n={} posts in that hour slot.",
                    best.1, best.2
                ),
                evidence: format!("n={total_posts} posts across {} hour slots", by_hour.len()),
                sample_size: total_posts as i64,
                caveat: format!("{caveat} Timing effects are usually small vs content quality."),
            });
        }

        // 4) Aspect-ratio group comparison (tall vs wide) via asset dims.
        let mut tall: Vec<f64> = Vec::new();
        let mut wide: Vec<f64> = Vec::new();
        for (_, _, m, _, _, _, w, h) in &data {
            if let (Some(w), Some(h), Some(v)) = (w, h, metric(m, "views")) {
                if *h > *w {
                    tall.push(v)
                } else {
                    wide.push(v)
                }
            }
        }
        if tall.len() >= 2 && wide.len() >= 2 {
            let ta = tall.iter().sum::<f64>() / tall.len() as f64;
            let wa = wide.iter().sum::<f64>() / wide.len() as f64;
            out.push(Insight {
                kind: "aspect_vs_views".into(),
                title: "Vertical vs horizontal posts".into(),
                detail: format!(
                    "Tall avg {:.0} views (n={}) vs wide {:.0} (n={}).",
                    ta,
                    tall.len(),
                    wa,
                    wide.len()
                ),
                evidence: format!("n={} posts with dimension data", tall.len() + wide.len()),
                sample_size: (tall.len() + wide.len()) as i64,
                caveat: format!(
                    "{caveat} Aspect usually tracks the platform itself — compare within a platform before concluding."
                ),
            });
        }

        // 5) Data coverage — which metrics are simply absent.
        let n = data.len() as i64;
        out.push(Insight {
            kind: "coverage".into(),
            title: "Data coverage".into(),
            detail: format!(
                "{n} posts have at least one stats snapshot in the last {days} days."
            ),
            evidence: "counts metric_snapshots joined to published targets".into(),
            sample_size: n,
            caveat: "Posts without connected accounts or remote ids can never produce API stats."
                .into(),
        });
        Ok(out)
    })
}

/// Account-level snapshot history per platform (for follower charts).
/// Returns accounts (id, platform_user_id) + snapshots ordered by time.
#[tauri::command]
pub fn analytics_account_history(
    db: State<'_, Arc<Db>>,
    platform: Option<String>,
) -> CmdResult<serde_json::Value> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT s.id, s.account_id, a.platform, a.platform_user_id,
                    s.fetched_at, s.source, s.metrics_json
             FROM account_snapshots s
             JOIN social_accounts a ON a.id=s.account_id
             WHERE (?1 IS NULL OR a.platform=?1)
             ORDER BY s.fetched_at ASC",
        )?;
        let rows = stmt
            .query_map([platform], |r| {
                let mj: String = r.get(6)?;
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "accountId": r.get::<_, String>(1)?,
                    "platform": r.get::<_, String>(2)?,
                    "platformUserId": r.get::<_, String>(3)?,
                    "fetchedAt": r.get::<_, String>(4)?,
                    "source": r.get::<_, String>(5)?,
                    "metrics": serde_json::from_str::<serde_json::Value>(&mj)
                        .unwrap_or(serde_json::json!([])),
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(serde_json::json!({"rows": rows}))
    })
}

#[tauri::command]
pub fn analytics_platform_stats_info() -> CmdResult<serde_json::Value> {
    Ok(serde_json::json!({
        "youtube": stats::stats_capability("youtube"),
        "tiktok": stats::stats_capability("tiktok"),
        "instagram": stats::stats_capability("instagram"),
        "facebook": stats::stats_capability("facebook"),
    }))
}

//! Phase 10 hardening regression tests: interrupted-job sweep and
//! oversized-project rejection.

use creatora_lib::db::Db;
use creatora_lib::error::AppError;
use creatora_lib::jobs::JobManager;
use creatora_lib::project::store;
use std::sync::Arc;

#[test]
fn running_jobs_are_swept_to_interrupted_on_startup() {
    let dir = std::env::temp_dir().join(format!("creatora-hr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Arc::new(Db::open(&dir).unwrap());
    // Simulate a job left 'running' by a crash.
    db.with(|c| {
        c.execute(
            "INSERT INTO jobs(id,kind,payload_json,status) VALUES('j1','render','{}','running')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let jobs = JobManager::default();
    jobs.attach_db(db.clone());
    jobs.sweep_interrupted();

    let status: String = db
        .with(|c| {
            c.query_row("SELECT status FROM jobs WHERE id='j1'", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(status, "interrupted");

    // A genuinely finished job must not be touched.
    db.with(|c| {
        c.execute(
            "INSERT INTO jobs(id,kind,payload_json,status) VALUES('j2','render','{}','done')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    jobs.sweep_interrupted();
    let status: String = db
        .with(|c| {
            c.query_row("SELECT status FROM jobs WHERE id='j2'", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(status, "done");
}

#[test]
fn oversized_project_file_is_rejected() {
    let dir = std::env::temp_dir().join(format!("creatora-hr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("huge.creatora");
    // Sparse 65 MiB file — no real IO, just metadata.
    std::fs::File::create(&p)
        .unwrap()
        .set_len(65 << 20)
        .unwrap();
    match store::open(&p) {
        Err(AppError::InvalidInput(m)) => assert!(m.contains("too large"), "{m}"),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

/// Perf benchmark: 10k snapshots across 50 targets — dashboard-shaped
/// query must stay interactive (<100 ms) on indexed tables.
#[test]
fn analytics_dashboard_query_scales_to_10k_snapshots() {
    let dir = std::env::temp_dir().join(format!("creatora-hr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(&dir).unwrap();

    db.with(|c| {
        c.execute_batch("BEGIN")?;
        for t in 0..50 {
            let pid = format!("p{t}");
            let tid = format!("t{t}");
            c.execute(
                "INSERT INTO social_posts(id,title,status) VALUES(?1,'p','published')",
                [&pid],
            )?;
            c.execute(
                "INSERT INTO social_post_targets(id,post_id,platform,status,platform_post_id)
                 VALUES(?1,?2,?3,'published',?4)",
                rusqlite::params![tid, pid, ["youtube","tiktok","instagram","facebook"][t % 4], format!("r{t}")],
            )?;
            for s in 0..200 {
                c.execute(
                    "INSERT INTO metric_snapshots(target_id,remote_id,platform,fetched_at,period,source,metrics_json)
                     VALUES(?1,?2,?3,datetime('now',printf('-%d days',?4)),'lifetime','api','{\"views\":1000}')",
                    rusqlite::params![tid, format!("r{t}"), ["youtube","tiktok","instagram","facebook"][t % 4], s],
                )?;
            }
        }
        c.execute_batch("COMMIT")?;
        Ok(())
    })
    .unwrap();

    let start = std::time::Instant::now();
    let mut count = 0usize;
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT s.target_id, s.platform, s.metrics_json
             FROM metric_snapshots s
             JOIN social_post_targets t ON t.id=s.target_id
             JOIN social_posts p ON p.id=t.post_id
             WHERE s.fetched_at >= datetime('now', ?1)
               AND (?2 IS NULL OR s.platform=?2)
             ORDER BY s.fetched_at DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params!["-30 days", rusqlite::types::Null], |r| {
            r.get::<_, String>(0)
        })?;
        for r in rows {
            r?;
            count += 1;
        }
        Ok::<(), creatora_lib::error::AppError>(())
    })
    .unwrap();
    let elapsed = start.elapsed();
    assert!(count > 0);
    assert!(
        elapsed.as_millis() < 100,
        "dashboard query over {count} rows took {elapsed:?} — check indexes"
    );
    eprintln!("benchmark: {count} rows in {elapsed:?}");
}

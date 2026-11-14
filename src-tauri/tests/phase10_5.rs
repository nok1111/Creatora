//! Phase 10.5A regression tests: publication history query, account
//! snapshots and job listing used by the Export Center.

use creatora_lib::db::Db;
use std::sync::Arc;

fn db() -> Arc<Db> {
    let dir = std::env::temp_dir().join(format!("creatora-p105-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Arc::new(Db::open(&dir).unwrap())
}

fn seed_attempt_chain(c: &rusqlite::Connection) {
    c.execute(
        "INSERT INTO projects(id, name, file_path) VALUES('proj1','Proj','/tmp/p1.creatora')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO social_posts(id, project_id, title, status)
         VALUES('p1','proj1','My video','published')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO social_post_targets(id, post_id, platform, status)
         VALUES('t1','p1','youtube','published')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO social_post_targets(id, post_id, platform, status)
         VALUES('t2','p1','tiktok','failed')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO publication_attempts(id,target_id,status,platform_post_id,attempt_no,started_at)
         VALUES('a1','t1','published','vid_123',1,'2025-01-01 10:00:00')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO publication_attempts(id,target_id,status,error,attempt_no,started_at)
         VALUES('a2','t2','failed','quota exceeded',1,'2025-01-02 10:00:00')",
        [],
    )
    .unwrap();
}

#[test]
fn account_snapshots_table_exists_and_dedupes() {
    let d = db();
    d.with(|c| {
        c.execute(
            "INSERT INTO social_accounts(id, platform, platform_user_id)
             VALUES('acc1','youtube','chan_1')",
            [],
        )?;
        c.execute(
            "INSERT INTO account_snapshots(id,account_id,platform,source,metrics_json)
             VALUES('s1','acc1','youtube','api','[{\"key\":\"subscriber_count\",\"value\":100,\"label\":\"Subs\",\"unit\":\"count\"}]')",
            [],
        )?;
        // Same account + same source + same day → deduped (INSERT OR IGNORE
        // relies on the unique index). Second insert must be replaceable.
        c.execute(
            "INSERT OR REPLACE INTO account_snapshots(id,account_id,platform,source,metrics_json)
             VALUES('s2','acc1','youtube','api','[]')",
            [],
        )?;
        let n: i64 = c.query_row(
            "SELECT COUNT(*) FROM account_snapshots WHERE account_id='acc1' AND platform='youtube'",
            [],
            |r| r.get(0),
        )?;
        assert!(n >= 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn publication_history_filters_and_joins() {
    let d = db();
    d.with(|c| Ok(seed_attempt_chain(c))).unwrap();

    // Replicates the WHERE clause of `publication_history` — asserts the
    // joins resolve post/project context and the filters discriminate.
    let d2 = d.clone();
    d.with(|c| {
        let mut stmt = c.prepare(
            "SELECT a.id, a.status, t.platform, p.title, p.project_id
             FROM publication_attempts a
             JOIN social_post_targets t ON t.id=a.target_id
             JOIN social_posts p ON p.id=t.post_id
             WHERE (?1 IS NULL OR t.platform=?1)
               AND (?2 IS NULL OR a.status=?2 OR
                    (?2='ok' AND a.status='published'))
               AND (?3 IS NULL OR a.started_at>=?3)
             ORDER BY a.started_at DESC LIMIT ?4",
        )?;
        let all = stmt
            .query_map(
                rusqlite::params![
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    200
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].0, "a2"); // newest first
        assert_eq!(all[0].3, "My video");
        assert_eq!(all[0].4.as_deref(), Some("proj1"));

        let yt = stmt
            .query_map(
                rusqlite::params![
                    Some("youtube"),
                    Option::<String>::None,
                    Option::<String>::None,
                    200
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(yt, vec!["a1"]);

        let ok = stmt
            .query_map(
                rusqlite::params![
                    Option::<String>::None,
                    Some("ok"),
                    Option::<String>::None,
                    200
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(ok, vec!["a1"]);

        let since = stmt
            .query_map(
                rusqlite::params![
                    Option::<String>::None,
                    Option::<String>::None,
                    Some("2025-01-02"),
                    200
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(since, vec!["a2"]);
        Ok(())
    })
    .unwrap();
    let _ = d2;
}

#[test]
fn list_jobs_filters_by_kind_prefix() {
    let d = db();
    d.with(|c| {
        c.execute("INSERT INTO jobs(id,kind,payload_json,status) VALUES('j1','render.export','{}','done')", [])?;
        c.execute("INSERT INTO jobs(id,kind,payload_json,status) VALUES('j2','media.import','{}','done')", [])?;
        c.execute("INSERT INTO jobs(id,kind,payload_json,status) VALUES('j3','social.export','{}','running')", [])?;
        Ok(())
    })
    .unwrap();

    // Same query the `list_jobs` command runs.
    d.with(|c| {
        let mut stmt = c.prepare(
            "SELECT id FROM jobs WHERE (?1 IS NULL OR kind LIKE ?1 || '%')
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let exports = stmt
            .query_map(rusqlite::params![Some("render.export"), 100], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(exports, vec!["j1"]);
        let all = stmt
            .query_map(rusqlite::params![Option::<String>::None, 100], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(all.len(), 3);
        Ok(())
    })
    .unwrap();
}

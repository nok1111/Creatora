//! Phase 8 integration: real SQLite round-trips for the social model —
//! post/target lifecycle, scheduling query, attempt log, caption
//! templates, hashtag history, cascade delete. Same Db the app opens.

use creatora_lib::db::Db;
use creatora_lib::social::scheduler::due_targets;
use creatora_lib::social::validate::now_unix;
use std::sync::Arc;

fn db() -> (Arc<Db>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("creatora-soc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    (Arc::new(Db::open(&dir).expect("open test db")), dir)
}

#[test]
fn post_target_lifecycle_and_status_rules() {
    let (db, dir) = db();
    db.with(|c| {
        c.execute(
            "INSERT INTO social_posts(id, title, caption, hashtags_json)
             VALUES('p','T','cap','[]')",
            [],
        )?;
        c.execute(
            "INSERT INTO social_post_targets(id, post_id, platform, status)
             VALUES('t','p','youtube','draft')",
            [],
        )?;
        c.execute(
            "UPDATE social_post_targets SET status='scheduled',
             scheduled_at='2099-01-01T12:00' WHERE id='t'",
            [],
        )?;
        let st: String = c.query_row(
            "SELECT status FROM social_post_targets WHERE id='t'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(st, "scheduled");
        // platform CHECK rejects garbage
        assert!(c
            .execute(
                "INSERT INTO social_post_targets(id, post_id, platform)
                 VALUES('x','p','myspace')",
                [],
            )
            .is_err());
        // attempt log: uploading -> failed keeps the error
        c.execute(
            "INSERT INTO publication_attempts(id, target_id, status, attempt_no)
             VALUES('a1','t','uploading',1)",
            [],
        )?;
        c.execute(
            "UPDATE publication_attempts SET status='failed', error='net down',
             finished_at=datetime('now') WHERE id='a1'",
            [],
        )?;
        let (s, e): (String, String) = c.query_row(
            "SELECT status, error FROM publication_attempts WHERE id='a1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert_eq!(s, "failed");
        assert_eq!(e, "net down");
        Ok(())
    })
    .unwrap();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cascade_delete_removes_targets_and_attempts() {
    let (db, dir) = db();
    db.with(|c| {
        c.execute("INSERT INTO social_posts(id, title) VALUES('p2','x')", [])?;
        c.execute(
            "INSERT INTO social_post_targets(id, post_id, platform)
             VALUES('t2','p2','tiktok')",
            [],
        )?;
        c.execute(
            "INSERT INTO publication_attempts(id, target_id, status)
             VALUES('a2','t2','uploading')",
            [],
        )?;
        c.execute("DELETE FROM social_posts WHERE id='p2'", [])?;
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM social_post_targets WHERE post_id='p2'",
                [],
                |r| r.get::<_, i64>(0),
            )?,
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM publication_attempts WHERE target_id='t2'",
                [],
                |r| r.get::<_, i64>(0),
            )?,
            0
        );
        Ok(())
    })
    .unwrap();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn templates_and_hashtag_history_roundtrip() {
    let (db, dir) = db();
    db.with(|c| {
        c.execute(
            "INSERT INTO caption_templates(id,name,body,hashtags_json)
             VALUES('ct','Promo','Check it out','[\"promo\",\"new\"]')",
            [],
        )?;
        c.execute(
            "INSERT INTO hashtag_history(tag, uses) VALUES('promo',3)",
            [],
        )?;
        c.execute(
            "INSERT INTO hashtag_history(tag, uses) VALUES('promo',1)
             ON CONFLICT(tag) DO UPDATE SET uses = uses + 1",
            [],
        )?;
        let (name, tags): (String, String) = c.query_row(
            "SELECT name, hashtags_json FROM caption_templates WHERE id='ct'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert_eq!(name, "Promo");
        assert!(tags.contains("promo"));
        assert_eq!(
            c.query_row(
                "SELECT uses FROM hashtag_history WHERE tag='promo'",
                [],
                |r| r.get::<_, i64>(0),
            )?,
            4
        );
        Ok(())
    })
    .unwrap();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn due_targets_finds_past_scheduled_only() {
    let (db, dir) = db();
    db.with(|c| {
        c.execute("INSERT INTO social_posts(id, title) VALUES('p3','Due')", [])?;
        // past → due
        c.execute(
            "INSERT INTO social_post_targets(id, post_id, platform, status,
                 scheduled_at, auto_publish)
             VALUES('past','p3','youtube','scheduled','2000-01-01T10:00',0)",
            [],
        )?;
        // future → not due
        c.execute(
            "INSERT INTO social_post_targets(id, post_id, platform, status,
                 scheduled_at)
             VALUES('future','p3','facebook','scheduled','2999-01-01T10:00')",
            [],
        )?;
        // past but not scheduled status → not due
        c.execute(
            "INSERT INTO social_post_targets(id, post_id, platform, status,
                 scheduled_at)
             VALUES('draft','p3','tiktok','draft','2000-01-01T10:00')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let due = due_targets(&db, now_unix()).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].target_id, "past");
    std::fs::remove_dir_all(&dir).ok();
}

pub mod migrations;

use crate::error::AppError;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Single shared connection. rusqlite Connection is !Sync; the Mutex serializes
/// access. All catalog queries are short; heavy work uses spawn_blocking.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if needed) the catalog DB at `dir/creatora.db` and
    /// apply any pending migrations.
    pub fn open(dir: &Path) -> Result<Self, AppError> {
        std::fs::create_dir_all(dir)?;
        let path: PathBuf = dir.join("creatora.db");
        let conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        migrations::migrate(&conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    /// Run `f` with the connection. Callers must not hold the lock across await.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, AppError>) -> Result<T, AppError> {
        let conn = self.conn.lock();
        f(&conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_db_and_migrates() {
        let dir = std::env::temp_dir().join(format!("creatora-test-{}", uuid::Uuid::new_v4()));
        let db = Db::open(&dir).expect("db opens");
        let version: i64 = db
            .with(|c| {
                c.pragma_query_value(None, "user_version", |r| r.get(0))
                    .map_err(AppError::from)
            })
            .expect("read user_version");
        assert_eq!(version, migrations::MIGRATIONS.len() as i64);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrations_are_idempotent() {
        let dir = std::env::temp_dir().join(format!("creatora-test-{}", uuid::Uuid::new_v4()));
        let _ = Db::open(&dir).expect("first open");
        let _ = Db::open(&dir).expect("second open");
        std::fs::remove_dir_all(&dir).ok();
    }
}

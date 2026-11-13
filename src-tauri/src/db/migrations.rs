use crate::error::AppError;
use rusqlite::Connection;

/// Ordered, embedded migrations. Each entry is applied once inside a
/// transaction; `PRAGMA user_version` tracks how many have run.
/// Never edit a shipped migration — add a new file at the end.
pub const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../../migrations/0001_init.sql")),
    (
        "0002_asset_favorites",
        include_str!("../../migrations/0002_asset_favorites.sql"),
    ),
];

pub fn migrate(conn: &Connection) -> Result<(), AppError> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (idx, (name, sql)) in MIGRATIONS.iter().enumerate() {
        if (idx as i64) < applied {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)
            .map_err(|e| AppError::Db(format!("migration {name} failed: {e}")))?;
        tx.pragma_update(None, "user_version", idx as i64 + 1)?;
        tx.commit()?;
        log::info!("applied migration {name} (user_version={})", idx + 1);
    }
    Ok(())
}

//! Local usage ledger (SQLite). One row per upstream request.

use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;

pub struct Ledger {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
pub struct Totals {
    pub requests: u64,
    pub tokens: u64,
}

impl Ledger {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> anyhow::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> anyhow::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS usage (
               id INTEGER PRIMARY KEY,
               account_id TEXT NOT NULL,
               ts INTEGER NOT NULL,
               model TEXT,
               status INTEGER,
               prompt_tokens INTEGER NOT NULL DEFAULT 0,
               completion_tokens INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS usage_account_ts ON usage(account_id, ts);
             CREATE TABLE IF NOT EXISTS blocks (
               account_id TEXT PRIMARY KEY,
               until INTEGER NOT NULL,
               reason TEXT
             );",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Reserve a request slot; returns the row id.
    pub fn begin(&self, account_id: &str, model: &str, at: DateTime<Utc>) -> anyhow::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO usage(account_id, ts, model) VALUES (?1, ?2, ?3)",
            params![account_id, at.timestamp_millis(), model],
        )?;
        Ok(c.last_insert_rowid())
    }

    pub fn finish(&self, row: i64, status: u16, prompt: u64, completion: u64) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE usage SET status=?2, prompt_tokens=?3, completion_tokens=?4 WHERE id=?1",
            params![row, status, prompt as i64, completion as i64],
        )?;
        Ok(())
    }

    /// Drop a reservation for a request the provider did not count.
    pub fn cancel(&self, row: i64) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM usage WHERE id=?1", params![row])?;
        Ok(())
    }

    pub fn totals_since(&self, account_id: &str, since: DateTime<Utc>) -> anyhow::Result<Totals> {
        let c = self.conn.lock().unwrap();
        let (r, t): (i64, i64) = c.query_row(
            "SELECT COUNT(*), COALESCE(SUM(prompt_tokens + completion_tokens), 0)
             FROM usage WHERE account_id=?1 AND ts>=?2",
            params![account_id, since.timestamp_millis()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(Totals { requests: r as u64, tokens: t as u64 })
    }

    pub fn block(&self, account_id: &str, until: DateTime<Utc>, reason: &str) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO blocks(account_id, until, reason) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET until=excluded.until, reason=excluded.reason",
            params![account_id, until.timestamp_millis(), reason],
        )?;
        Ok(())
    }

    pub fn blocked_until(&self, account_id: &str, now: DateTime<Utc>) -> anyhow::Result<Option<(DateTime<Utc>, String)>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare("SELECT until, reason FROM blocks WHERE account_id=?1")?;
        let mut rows = stmt.query(params![account_id])?;
        if let Some(row) = rows.next()? {
            let until: i64 = row.get(0)?;
            let reason: Option<String> = row.get(1)?;
            let until = DateTime::<Utc>::from_timestamp_millis(until).unwrap_or(now);
            if until > now {
                return Ok(Some((until, reason.unwrap_or_default())));
            }
        }
        Ok(None)
    }

    pub fn clear_account(&self, account_id: &str) -> anyhow::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM usage WHERE account_id=?1", params![account_id])?;
        c.execute("DELETE FROM blocks WHERE account_id=?1", params![account_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn begin_finish_cancel() {
        let l = Ledger::in_memory().unwrap();
        let now = Utc::now();
        let a = l.begin("a", "m", now).unwrap();
        l.finish(a, 200, 10, 5).unwrap();
        let b = l.begin("a", "m", now).unwrap();
        l.cancel(b).unwrap();
        assert_eq!(l.totals_since("a", now - Duration::seconds(1)).unwrap(), Totals { requests: 1, tokens: 15 });
        assert_eq!(l.totals_since("b", now - Duration::seconds(1)).unwrap(), Totals::default());
    }

    #[test]
    fn blocks_expire() {
        let l = Ledger::in_memory().unwrap();
        let now = Utc::now();
        l.block("a", now + Duration::seconds(30), "429").unwrap();
        assert!(l.blocked_until("a", now).unwrap().is_some());
        assert!(l.blocked_until("a", now + Duration::seconds(31)).unwrap().is_none());
    }
}

//! The user's own accounts. API keys are NOT stored here; they live in the
//! OS keychain and are looked up through [`SecretStore`].

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::catalog::Provider;
use crate::limits::{self, Limit};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    /// Short id used as the model prefix, e.g. `openrouter` or `openrouter-2`.
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub base_url: String,
    pub enabled: bool,
    /// Fraction of the free quota we allow ourselves to use.
    #[serde(default = "default_margin")]
    pub margin: f64,
    /// Limits derived from the catalog (refreshed when the catalog changes).
    #[serde(default)]
    pub limits: Vec<Limit>,
    pub added_at: DateTime<Utc>,
}

fn default_margin() -> f64 {
    0.9
}

impl Account {
    pub fn from_provider(id: String, p: &Provider, base_url: Option<String>, margin: f64) -> anyhow::Result<Self> {
        let api = p.api.as_ref().ok_or_else(|| anyhow::anyhow!("{} 不能当 API 使用", p.name))?;
        Ok(Self {
            id,
            provider_id: p.id.clone(),
            label: p.name_zh.clone().unwrap_or_else(|| p.name.clone()),
            base_url: base_url.unwrap_or_else(|| api.base_url.clone()).trim_end_matches('/').to_string(),
            enabled: true,
            margin,
            limits: limits::derive(&p.quotas, margin),
            added_at: Utc::now(),
        })
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, account_id: &str) -> Option<String>;
}

/// JSON file holding the account list (no secrets).
pub struct AccountFile {
    path: PathBuf,
}

impl AccountFile {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self { path: path.as_ref().to_path_buf() }
    }

    pub fn load(&self) -> anyhow::Result<Vec<Account>> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(serde_json::from_str(&s)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, accounts: &[Account]) -> anyhow::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(accounts)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

/// Pick a free account id based on the provider id.
pub fn next_id(provider_id: &str, existing: &[Account]) -> String {
    if !existing.iter().any(|a| a.id == provider_id) {
        return provider_id.to_string();
    }
    (2..).map(|n| format!("{provider_id}-{n}")).find(|c| !existing.iter().any(|a| &a.id == c)).unwrap()
}

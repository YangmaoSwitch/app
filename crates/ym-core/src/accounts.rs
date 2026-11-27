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
    /// Native Anthropic endpoint; when absent, Claude-format requests are not sent to this account (no conversion).
    #[serde(default)]
    pub anthropic_base_url: Option<String>,
    /// Only model ids ending with this suffix are routed here (e.g. `:free` on OpenRouter).
    #[serde(default)]
    pub model_suffix: Option<String>,
    /// Model ids reported by the provider's `/models`, after the suffix filter.
    #[serde(default)]
    pub models: Vec<String>,
}

impl Account {
    /// Whether a plain model id (no account prefix) should be routed to this account.
    pub fn serves(&self, model: &str) -> bool {
        self.enabled
            && self.model_suffix.as_deref().map_or(true, |s| model.ends_with(s))
            && self.models.iter().any(|m| m == model)
    }

    pub fn keep_model(&self, model: &str) -> bool {
        self.model_suffix.as_deref().map_or(true, |s| model.ends_with(s))
    }
}

fn default_margin() -> f64 {
    0.9
}

/// A user-edited API address must stay on the provider's own host (or a sibling under the same parent domain,
/// e.g. a per-account subdomain), over https unless the catalog itself uses http. The key is sent there, so
/// a typo or a pasted look-alike address must not leak it to someone else.
pub fn check_base_url(catalog_base: &str, custom: &str) -> anyhow::Result<()> {
    let want = url::Url::parse(catalog_base)?;
    let got = url::Url::parse(custom.trim()).map_err(|_| anyhow::anyhow!("接口地址不是合法网址"))?;
    if got.scheme() != "https" && got.scheme() != want.scheme() {
        anyhow::bail!("接口地址必须用 https");
    }
    let (w, g) = (want.host_str().unwrap_or_default().to_ascii_lowercase(), got.host_str().unwrap_or_default().to_ascii_lowercase());
    // parent of the catalog host: api.example.com -> example.com; keep at least two labels
    let labels: Vec<&str> = w.split('.').collect();
    let parent = if labels.len() > 2 { labels[1..].join(".") } else { w.clone() };
    if g == w || g == parent || g.ends_with(&format!(".{parent}")) {
        return Ok(());
    }
    anyhow::bail!("接口地址必须在 {w} 或 {parent} 域名下；Key 会发到这个地址")
}

impl Account {
    pub fn from_provider(id: String, p: &Provider, base_url: Option<String>, margin: f64) -> anyhow::Result<Self> {
        let api = p.api.as_ref().ok_or_else(|| anyhow::anyhow!("{} 不能当 API 使用", p.name))?;
        if let Some(b) = base_url.as_deref() {
            check_base_url(&api.base_url, b)?;
        }
        Ok(Self {
            id,
            provider_id: p.id.clone(),
            label: p.name_zh.clone().unwrap_or_else(|| p.name.clone()),
            base_url: base_url.unwrap_or_else(|| api.base_url.clone()).trim_end_matches('/').to_string(),
            enabled: true,
            margin,
            limits: limits::derive(&p.quotas, margin),
            added_at: Utc::now(),
            anthropic_base_url: api.anthropic_base_url.clone(),
            model_suffix: api.free_model_rule.as_deref().filter(|r| r.contains(":free")).map(|_| ":free".to_string()),
            models: Vec::new(),
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

#[cfg(test)]
mod tests {
    use super::check_base_url;

    #[test]
    fn custom_base_url_stays_on_provider_domain() {
        let cf = "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1";
        assert!(check_base_url(cf, "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1").is_ok());
        assert!(check_base_url("https://api.siliconflow.cn/v1", "https://api-st.siliconflow.cn/v1").is_ok());
        assert!(check_base_url("https://api.siliconflow.cn/v1", "https://siliconflow.cn.evil.com/v1").is_err());
        assert!(check_base_url("https://api.siliconflow.cn/v1", "http://api.siliconflow.cn/v1").is_err());
        assert!(check_base_url("https://openrouter.ai/api/v1", "https://openrouter.ai.example/api/v1").is_err());
        assert!(check_base_url("https://openrouter.ai/api/v1", "not a url").is_err());
    }
}

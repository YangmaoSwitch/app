use serde::{Deserialize, Serialize};

/// Public catalog URL (built by the catalog repo's CI).
pub const CATALOG_URL: &str = "https://raw.githubusercontent.com/YangmaoSwitch/catalog/dist/catalog.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalog {
    pub version: u32,
    #[serde(default)]
    pub generated_at: Option<String>,
    pub providers: Vec<Provider>,
}

impl Catalog {
    pub fn from_json(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }

    pub fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub name_zh: Option<String>,
    pub homepage: String,
    pub region: String,
    pub api_usable: bool,
    pub status: String,
    pub last_verified: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub api: Option<Api>,
    pub signup: Signup,
    #[serde(default)]
    pub quotas: Vec<Quota>,
    pub overage: String,
    pub onboarding: Onboarding,
    #[serde(default)]
    pub terms: Vec<Term>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Api {
    pub protocol: Vec<String>,
    pub base_url: String,
    /// Native Anthropic Messages endpoint (base, without `/v1/messages`), if the provider has one.
    #[serde(default)]
    pub anthropic_base_url: Option<String>,
    #[serde(default)]
    pub free_models: Vec<String>,
    #[serde(default)]
    pub free_model_rule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signup {
    pub url: String,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub regions_blocked: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quota {
    pub unit: String,
    #[serde(default)]
    pub amount: Option<f64>,
    pub period: String,
    #[serde(default)]
    pub reset: Option<String>,
    pub scope: String,
    #[serde(default)]
    pub models: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub expires_days: Option<i64>,
    #[serde(default)]
    pub note: Option<String>,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Onboarding {
    pub level: String,
    #[serde(default)]
    pub key_page: Option<String>,
    #[serde(default)]
    pub key_pattern: Option<String>,
    #[serde(default)]
    pub quota_api: Option<String>,
    #[serde(default)]
    pub quota_headers: Vec<String>,
    #[serde(default)]
    pub oauth: Option<OAuthInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthInfo {
    pub authorize_url: String,
    pub token_url: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    pub pkce: String,
    pub loopback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Term {
    pub point: String,
    pub url: String,
}

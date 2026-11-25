//! Local gateway: OpenAI-compatible (`/v1/chat/completions`, ...) and
//! Anthropic-compatible (`/v1/messages`) entry points on 127.0.0.1.
//!
//! * Clients authenticate with the local API key (`Authorization: Bearer` or `x-api-key`).
//! * `model: "auto"` lets the gateway pick: the best free model (by quality) that one of
//!   the user's accounts serves and that supports what the request needs (tools, images),
//!   then the next one. A model name from the model square (e.g. `DeepSeek V4.1 Flash`)
//!   goes to every account serving that model, whatever the provider calls it.
//! * Otherwise `model` is the provider's own model id. The gateway picks an enabled account
//!   that offers it, skipping accounts that hit their local cap or were rate limited.
//! * On 429 / 402 / auth errors / 5xx / timeouts it moves on to the next candidate before
//!   any byte reaches the client. `<account>/<model>` pins a specific account.
//! * Requests are forwarded with the user's own key; usage is recorded locally.
//! * Pure forwarding: OpenAI-format requests go to the provider's OpenAI endpoint,
//!   Claude-format requests go to the provider's native Anthropic endpoint. No format
//!   conversion; a provider without a native Claude endpoint returns an error.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use crate::accounts::{Account, SecretStore};
use crate::ledger::Ledger;
use crate::limits::{Limit, Unit};
use crate::routing::{Needs, Route, AUTO};

/// Upper bound on upstream attempts for one request, so a bad request does not walk every account.
const MAX_ATTEMPTS: usize = 8;

pub struct Gateway {
    accounts: RwLock<Vec<Account>>,
    routes: RwLock<Vec<Route>>,
    api_key: RwLock<String>,
    ledger: Arc<Ledger>,
    secrets: Arc<dyn SecretStore>,
    client: reqwest::Client,
    /// Serialises check-and-reserve so concurrent requests cannot overshoot a cap.
    reserve: tokio::sync::Mutex<()>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LimitUsage {
    pub label: String,
    pub unit: Unit,
    pub used: u64,
    pub cap: f64,
    pub amount: f64,
    pub resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountUsage {
    pub account_id: String,
    pub label: String,
    pub enabled: bool,
    pub blocked_until: Option<DateTime<Utc>>,
    pub blocked_reason: Option<String>,
    pub limits: Vec<LimitUsage>,
    pub today_requests: u64,
    pub today_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelEntry {
    pub id: String,
    pub accounts: Vec<String>,
}

/// Error raised before a response from the provider is available.
struct GwError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl GwError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }

    fn openai(self) -> Response {
        (self.status, Json(json!({"error": {"message": self.message, "type": "yangmao_switch", "code": self.code}}))).into_response()
    }

    fn anthropic(self) -> Response {
        let kind = match self.status {
            StatusCode::TOO_MANY_REQUESTS => "rate_limit_error",
            StatusCode::UNAUTHORIZED => "authentication_error",
            StatusCode::NOT_FOUND => "not_found_error",
            StatusCode::BAD_REQUEST => "invalid_request_error",
            _ => "api_error",
        };
        (self.status, Json(json!({"type": "error", "error": {"type": kind, "message": self.message}}))).into_response()
    }
}

/// A request that has been accepted by one account's upstream.
struct Accepted {
    resp: reqwest::Response,
    row: i64,
    /// `account/model` that served the request.
    served: String,
}

/// List the model ids an OpenAI-compatible provider offers.
pub async fn fetch_models(client: &reqwest::Client, base_url: &str, key: &str) -> anyhow::Result<Vec<String>> {
    let v: Value = client.get(format!("{base_url}/models")).bearer_auth(key).send().await?.error_for_status()?.json().await?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

impl Gateway {
    pub fn new(accounts: Vec<Account>, api_key: String, ledger: Arc<Ledger>, secrets: Arc<dyn SecretStore>) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("YangmaoSwitch/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("http client");
        Arc::new(Self {
            accounts: RwLock::new(accounts),
            routes: RwLock::new(Vec::new()),
            api_key: RwLock::new(api_key),
            ledger,
            secrets,
            client,
            reserve: tokio::sync::Mutex::new(()),
        })
    }

    pub fn set_accounts(&self, accounts: Vec<Account>) {
        *self.accounts.write().unwrap() = accounts;
    }

    /// Model routes from the model square data, best first (see [`crate::routing::parse`]).
    pub fn set_routes(&self, routes: Vec<Route>) {
        *self.routes.write().unwrap() = routes;
    }

    pub fn set_api_key(&self, key: String) {
        *self.api_key.write().unwrap() = key;
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        let expected = self.api_key.read().unwrap().clone();
        if expected.is_empty() {
            return true;
        }
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")));
        let x_key = headers.get("x-api-key").and_then(|v| v.to_str().ok());
        bearer.map(str::trim) == Some(expected.as_str()) || x_key.map(str::trim) == Some(expected.as_str())
    }

    /// Models available through the gateway (plain ids, with the accounts offering them).
    pub fn models(&self) -> Vec<ModelEntry> {
        let accounts = self.accounts.read().unwrap().clone();
        let mut out: Vec<ModelEntry> = Vec::new();
        for a in accounts.iter().filter(|a| a.enabled) {
            for m in a.models.iter().filter(|m| a.keep_model(m)) {
                match out.iter_mut().find(|e| &e.id == m) {
                    Some(e) => e.accounts.push(a.id.clone()),
                    None => out.push(ModelEntry { id: m.clone(), accounts: vec![a.id.clone()] }),
                }
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// Free models from the model square that at least one enabled account serves, best first.
    pub fn routed_models(&self) -> Vec<ModelEntry> {
        let accounts = self.accounts.read().unwrap().clone();
        let routes = self.routes.read().unwrap().clone();
        routes
            .iter()
            .filter_map(|r| {
                let ids: Vec<String> = route_accounts(r, &accounts, false).into_iter().map(|(a, _)| a.id).collect();
                (!ids.is_empty()).then(|| ModelEntry { id: r.name.clone(), accounts: dedup(ids) })
            })
            .collect()
    }

    /// Accounts that can serve `model`, in priority order, with the upstream model id.
    fn candidates(&self, model: &str, claude: bool, needs: Needs) -> Result<Vec<(Account, String)>, GwError> {
        let accounts = self.accounts.read().unwrap().clone();
        if model.eq_ignore_ascii_case(AUTO) {
            let routes = self.routes.read().unwrap().clone();
            let mut found: Vec<(Account, String)> = Vec::new();
            for r in routes.iter().filter(|r| needs.met_by(r)) {
                push_new(&mut found, route_accounts(r, &accounts, claude));
            }
            if found.is_empty() {
                return Err(GwError::new(
                    StatusCode::NOT_FOUND,
                    "no_free_model",
                    if claude {
                        "已启用的账号里没有能走 Claude 接口的免费模型，请改用 OpenAI 接口，或先添加智谱、硅基流动等账号"
                    } else {
                        "已启用的账号里没有符合要求的免费模型，请先在“我的账号”添加 Key 并测试连接"
                    },
                ));
            }
            return Ok(found);
        }
        let no_native = |a: &Account| {
            GwError::new(
                StatusCode::BAD_REQUEST,
                "claude_api_unavailable",
                format!("{} 没有原生 Claude 接口，请改用 OpenAI 接口（Base URL 加 /v1）", a.label),
            )
        };
        if let Some((prefix, rest)) = model.split_once('/') {
            if let Some(a) = accounts.iter().find(|a| a.id == prefix) {
                if !a.enabled {
                    return Err(GwError::new(StatusCode::FORBIDDEN, "account_disabled", format!("账号 {prefix} 已停用")));
                }
                if claude && a.anthropic_base_url.is_none() {
                    return Err(no_native(a));
                }
                return Ok(vec![(a.clone(), rest.to_string())]);
            }
        }
        let serving: Vec<&Account> = accounts.iter().filter(|a| a.serves(model)).collect();
        let mut found: Vec<(Account, String)> = serving
            .iter()
            .filter(|a| !claude || a.anthropic_base_url.is_some())
            .map(|a| ((*a).clone(), model.to_string()))
            .collect();
        // The same model on other providers, under their own ids.
        let routes = self.routes.read().unwrap().clone();
        if let Some(r) = routes.iter().find(|r| r.matches(model)) {
            push_new(&mut found, route_accounts(r, &accounts, claude));
        }
        if found.is_empty() && !serving.is_empty() {
            return Err(no_native(serving[0]));
        }
        if found.is_empty() {
            return Err(GwError::new(
                StatusCode::NOT_FOUND,
                "model_not_found",
                format!("已启用的账号里没有提供模型 {model}。可以用 GET /v1/models 查看可用模型，或写成 <账号>/<模型> 指定账号"),
            ));
        }
        Ok(found)
    }

    /// First limit that would be exceeded by one more request, if any.
    fn exceeded(&self, acct: &Account, now: DateTime<Utc>) -> anyhow::Result<Option<(Limit, u64)>> {
        for l in &acct.limits {
            let t = self.ledger.totals_since(&acct.id, l.window.start(now, acct.added_at))?;
            let used = if l.unit == Unit::Requests { t.requests } else { t.tokens };
            let over = match l.unit {
                Unit::Requests => (used + 1) as f64 > l.cap,
                Unit::Tokens => used as f64 >= l.cap,
            };
            if over {
                return Ok(Some((l.clone(), used)));
            }
        }
        Ok(None)
    }

    /// Try candidates in order until one upstream accepts the request.
    /// `build(account, upstream_model)` returns (url, body, native_anthropic).
    async fn dispatch(&self, cands: Vec<(Account, String)>, build: impl Fn(&Account, &str) -> (String, Value, bool)) -> Result<Accepted, GwError> {
        let mut reasons: Vec<String> = Vec::new();
        let mut attempts = 0usize;
        let total = cands.len();
        for (i, (acct, model)) in cands.into_iter().enumerate() {
            if attempts >= MAX_ATTEMPTS {
                reasons.push(format!("已尝试 {MAX_ATTEMPTS} 次，其余 {} 个未试", total - i));
                break;
            }
            let last = i + 1 == total;
            let row = {
                let _g = self.reserve.lock().await;
                let now = Utc::now();
                if let Ok(Some((until, why))) = self.ledger.blocked_until(&acct.id, now) {
                    reasons.push(format!("{} 暂停到 {}（{why}）", acct.id, until.with_timezone(&chrono::Local).format("%H:%M")));
                    continue;
                }
                match self.exceeded(&acct, now) {
                    Ok(Some((l, used))) => {
                        let reset = l.window.next_reset(now, acct.added_at).map(|t| format!("，{} 重置", t.with_timezone(&chrono::Local).format("%m-%d %H:%M"))).unwrap_or_default();
                        reasons.push(format!("{} 已用到本地上限 {used}/{}（{}）{reset}", acct.id, l.cap, l.label));
                        continue;
                    }
                    Ok(None) => {}
                    Err(e) => return Err(GwError::new(StatusCode::INTERNAL_SERVER_ERROR, "ledger", e.to_string())),
                }
                match self.ledger.begin(&acct.id, &model, now) {
                    Ok(r) => r,
                    Err(e) => return Err(GwError::new(StatusCode::INTERNAL_SERVER_ERROR, "ledger", e.to_string())),
                }
            };
            let Some(key) = self.secrets.get(&acct.id) else {
                let _ = self.ledger.cancel(row);
                reasons.push(format!("{} 在钥匙串里没有 Key", acct.id));
                continue;
            };
            attempts += 1;
            let (url, body, native) = build(&acct, &model);
            let mut req = self.client.post(&url).bearer_auth(&key).json(&body);
            if native {
                req = req.header("x-api-key", &key).header("anthropic-version", "2023-06-01");
            }
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = self.ledger.cancel(row);
                    reasons.push(format!("{} 连接失败：{e}", acct.id));
                    continue;
                }
            };
            let status = resp.status().as_u16();
            let now = Utc::now();
            if status == 429 || status == 402 {
                let (dur, why) = if status == 429 {
                    let secs = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(60);
                    (Duration::seconds(secs), "平台返回 429")
                } else {
                    (Duration::hours(1), "平台返回 402（额度或余额不足）")
                };
                let _ = self.ledger.block(&acct.id, now + dur, why);
                let _ = self.ledger.cancel(row);
                reasons.push(format!("{} {why}", acct.id));
                continue;
            }
            // Other failures that are about this account or model, not the request itself:
            // try the next candidate; the last one's error goes back to the client as is.
            if !last {
                let skip = match status {
                    401 | 403 => Some((Some(Duration::hours(1)), "Key 无效或没有权限")),
                    404 => Some((None, "平台上没有这个模型")),
                    408 | 500..=599 => Some((Some(Duration::seconds(30)), "平台暂时出错")),
                    _ => None,
                };
                if let Some((pause, why)) = skip {
                    if let Some(d) = pause {
                        let _ = self.ledger.block(&acct.id, now + d, &format!("{why}（{status}）"));
                    }
                    let _ = self.ledger.cancel(row);
                    reasons.push(format!("{}/{model} {why}（{status}）", acct.id));
                    continue;
                }
            }
            if !resp.status().is_success() {
                let _ = self.ledger.cancel(row);
            }
            return Ok(Accepted { resp, row, served: format!("{}/{model}", acct.id) });
        }
        Err(GwError::new(StatusCode::TOO_MANY_REQUESTS, "local_quota_reached", format!("没有可用的账号：{}", reasons.join("；"))))
    }

    pub fn usage(&self) -> Vec<AccountUsage> {
        let now = Utc::now();
        let accounts = self.accounts.read().unwrap().clone();
        accounts
            .iter()
            .map(|a| {
                let limits = a
                    .limits
                    .iter()
                    .map(|l| {
                        let t = self.ledger.totals_since(&a.id, l.window.start(now, a.added_at)).unwrap_or_default();
                        LimitUsage {
                            label: l.label.clone(),
                            unit: l.unit,
                            used: if l.unit == Unit::Requests { t.requests } else { t.tokens },
                            cap: l.cap,
                            amount: l.amount,
                            resets_at: l.window.next_reset(now, a.added_at),
                        }
                    })
                    .collect();
                let today = self.ledger.totals_since(&a.id, now - Duration::hours(24)).unwrap_or_default();
                let blocked = self.ledger.blocked_until(&a.id, now).ok().flatten();
                AccountUsage {
                    account_id: a.id.clone(),
                    label: a.label.clone(),
                    enabled: a.enabled,
                    blocked_until: blocked.as_ref().map(|b| b.0),
                    blocked_reason: blocked.map(|b| b.1),
                    limits,
                    today_requests: today.requests,
                    today_tokens: today.tokens,
                }
            })
            .collect()
    }

    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/health", get(|| async { "ok" }))
            .route("/v1/models", get(list_models))
            .route("/v1/messages", post(messages))
            .route("/v1/messages/count_tokens", post(count_tokens))
            .route("/v1/{*path}", post(openai))
            .with_state(self.clone())
    }

    /// Bind on 127.0.0.1 only and serve in the background.
    pub async fn serve(self: &Arc<Self>, port: u16) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        let addr = listener.local_addr()?;
        let app = self.router();
        let handle = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("gateway stopped: {e}");
            }
        });
        Ok((addr, handle))
    }
}

/// Enabled accounts that serve one of the route's free offers, with the upstream id.
fn route_accounts(r: &Route, accounts: &[Account], claude: bool) -> Vec<(Account, String)> {
    let mut out = Vec::new();
    for o in &r.offers {
        for a in accounts.iter().filter(|a| a.enabled && a.provider_id == o.provider && a.keep_model(&o.model)) {
            // A fetched model list that lacks the id means this account cannot use it.
            if !a.models.is_empty() && !a.models.iter().any(|m| m == &o.model) {
                continue;
            }
            if claude && a.anthropic_base_url.is_none() {
                continue;
            }
            out.push((a.clone(), o.model.clone()));
        }
    }
    out
}

fn push_new(into: &mut Vec<(Account, String)>, more: Vec<(Account, String)>) {
    for c in more {
        if !into.iter().any(|(a, m)| a.id == c.0.id && m == &c.1) {
            into.push(c);
        }
    }
}

fn dedup(mut v: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|x| seen.insert(x.clone()));
    v
}

fn usage_from(v: &Value) -> Option<(u64, u64)> {
    let u = v.get("usage").or_else(|| v.pointer("/message/usage"))?;
    if u.is_null() {
        return None;
    }
    let get = |k: &str| u.get(k).and_then(Value::as_u64);
    Some((get("prompt_tokens").or_else(|| get("input_tokens")).unwrap_or(0), get("completion_tokens").or_else(|| get("output_tokens")).unwrap_or(0)))
}

fn content_type(resp: &reqwest::Response) -> String {
    resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string()
}

fn status_of(resp: &reqwest::Response) -> StatusCode {
    StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
}

/// Pass the upstream body through unchanged, recording usage found in it.
async fn passthrough(gw: Arc<Gateway>, a: Accepted, stream: bool) -> Response {
    let status = status_of(&a.resp);
    let ct = content_type(&a.resp);
    let ok = a.resp.status().is_success();
    let served = a.served.clone();
    if !ok || !stream {
        let bytes = a.resp.bytes().await.unwrap_or_default();
        if ok {
            let (p, c) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| usage_from(&v)).unwrap_or((0, 0));
            let _ = gw.ledger.finish(a.row, status.as_u16(), p, c);
        }
        return Response::builder().status(status).header(header::CONTENT_TYPE, ct).header("x-yangmao-served-by", served).body(Body::from(bytes)).unwrap();
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    let row = a.row;
    let code = status.as_u16();
    tokio::spawn(async move {
        let mut up = a.resp.bytes_stream();
        let mut buf = String::new();
        let mut usage = (0u64, 0u64);
        while let Some(chunk) = up.next().await {
            match chunk {
                Ok(b) => {
                    buf.push_str(&String::from_utf8_lossy(&b));
                    while let Some(i) = buf.find('\n') {
                        let line: String = buf.drain(..=i).collect();
                        if let Some(data) = line.trim().strip_prefix("data:") {
                            if data.contains("\"usage\"") {
                                if let Some(u) = serde_json::from_str::<Value>(data.trim()).ok().and_then(|v| usage_from(&v)) {
                                    usage = (usage.0.max(u.0), usage.1.max(u.1));
                                }
                            }
                        }
                    }
                    if tx.send(Ok(b)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e))).await;
                    break;
                }
            }
        }
        let _ = gw.ledger.finish(row, code, usage.0, usage.1);
    });
    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (c, rx)) }));
    Response::builder().status(status).header(header::CONTENT_TYPE, ct).header("x-yangmao-served-by", served).body(body).unwrap()
}

async fn list_models(State(gw): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if !gw.authorized(&headers) {
        return GwError::new(StatusCode::UNAUTHORIZED, "invalid_api_key", "本机入口的 API Key 不对，请在羊毛switch“接入工具”页复制").openai();
    }
    let mut data: Vec<Value> = vec![json!({"id": AUTO, "object": "model", "owned_by": "yangmao-switch", "type": "model", "display_name": "自动选择（最好的可用免费模型）"})];
    data.extend(
        gw.models()
            .into_iter()
            .map(|m| json!({"id": m.id, "object": "model", "owned_by": m.accounts.join(","), "type": "model", "display_name": m.id})),
    );
    Json(json!({"object": "list", "data": data, "has_more": false})).into_response()
}

async fn openai(State(gw): State<Arc<Gateway>>, Path(path): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    if !gw.authorized(&headers) {
        return GwError::new(StatusCode::UNAUTHORIZED, "invalid_api_key", "本机入口的 API Key 不对，请在羊毛switch“接入工具”页复制").openai();
    }
    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return GwError::new(StatusCode::BAD_REQUEST, "invalid_json", format!("请求体不是合法 JSON：{e}")).openai(),
    };
    let Some(model) = req.get("model").and_then(Value::as_str).map(str::to_string) else {
        return GwError::new(StatusCode::BAD_REQUEST, "missing_model", "缺少 model 字段").openai();
    };
    let cands = match gw.candidates(&model, false, Needs::of(&req)) {
        Ok(c) => c,
        Err(e) => return e.openai(),
    };
    let stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let is_chat = path.ends_with("chat/completions");
    let accepted = gw
        .dispatch(cands, |acct, m| {
            let mut b = req.clone();
            b["model"] = json!(m);
            if stream && is_chat && b.get("stream_options").is_none() {
                b["stream_options"] = json!({"include_usage": true});
            }
            (format!("{}/{}", acct.base_url, path), b, false)
        })
        .await;
    match accepted {
        Ok(a) => passthrough(gw, a, stream).await,
        Err(e) => e.openai(),
    }
}

async fn messages(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: Bytes) -> Response {
    if !gw.authorized(&headers) {
        return GwError::new(StatusCode::UNAUTHORIZED, "invalid_api_key", "本机入口的 API Key 不对，请在羊毛switch“接入工具”页复制").anthropic();
    }
    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return GwError::new(StatusCode::BAD_REQUEST, "invalid_json", format!("请求体不是合法 JSON：{e}")).anthropic(),
    };
    let Some(model) = req.get("model").and_then(Value::as_str).map(str::to_string) else {
        return GwError::new(StatusCode::BAD_REQUEST, "missing_model", "缺少 model 字段").anthropic();
    };
    let cands = match gw.candidates(&model, true, Needs::of(&req)) {
        Ok(c) => c,
        Err(e) => return e.anthropic(),
    };
    let stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let accepted = gw
        .dispatch(cands, |acct, m| {
            let mut b = req.clone();
            b["model"] = json!(m);
            let base = acct.anthropic_base_url.as_deref().unwrap_or_default().trim_end_matches('/');
            (format!("{base}/v1/messages"), b, true)
        })
        .await;
    match accepted {
        Ok(a) => passthrough(gw, a, stream).await,
        Err(e) => e.anthropic(),
    }
}

/// Forwarded to the provider's native endpoint; not counted against the request quota.
async fn count_tokens(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: Bytes) -> Response {
    if !gw.authorized(&headers) {
        return GwError::new(StatusCode::UNAUTHORIZED, "invalid_api_key", "本机入口的 API Key 不对").anthropic();
    }
    let mut req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let model = req.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
    let (acct, m) = match gw.candidates(&model, true, Needs::of(&req)) {
        Ok(mut c) => c.remove(0),
        Err(e) => return e.anthropic(),
    };
    let Some(key) = gw.secrets.get(&acct.id) else {
        return GwError::new(StatusCode::UNAUTHORIZED, "missing_key", format!("{} 在钥匙串里没有 Key", acct.id)).anthropic();
    };
    req["model"] = json!(m);
    let base = acct.anthropic_base_url.as_deref().unwrap_or_default().trim_end_matches('/').to_string();
    let resp = match gw
        .client
        .post(format!("{base}/v1/messages/count_tokens"))
        .bearer_auth(&key)
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .json(&req)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return GwError::new(StatusCode::BAD_GATEWAY, "upstream_unreachable", format!("连接 {} 失败：{e}", acct.label)).anthropic(),
    };
    let status = status_of(&resp);
    let ct = content_type(&resp);
    let bytes = resp.bytes().await.unwrap_or_default();
    Response::builder().status(status).header(header::CONTENT_TYPE, ct).body(Body::from(bytes)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::{Limit, Unit, Window};

    struct Keys;
    impl SecretStore for Keys {
        fn get(&self, _: &str) -> Option<String> {
            Some("test-key".into())
        }
    }

    async fn mock_upstream() -> String {
        let app = Router::new()
            .route(
                "/v1/chat/completions",
                post(|headers: HeaderMap, Json(v): Json<Value>| async move {
                    let auth = headers.get("authorization").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
                    if v["model"] == "boom" {
                        return (StatusCode::INTERNAL_SERVER_ERROR, "upstream down").into_response();
                    }
                    if v["stream"] == true {
                        let sse = "data: {\"id\":\"1\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
                        return ([(header::CONTENT_TYPE, "text/event-stream")], sse.to_string()).into_response();
                    }
                    Json(json!({"id": "x", "model": v["model"], "auth": auth,
                        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "hello"}}],
                        "usage": {"prompt_tokens": 7, "completion_tokens": 3}}))
                    .into_response()
                }),
            )
            .route("/v1/models", get(|| async { Json(json!({"data": [{"id": "a:free"}, {"id": "b"}]})) }))
            .route(
                "/v1/messages",
                post(|Json(v): Json<Value>| async move {
                    Json(json!({"id": "msg_1", "type": "message", "role": "assistant", "model": v["model"],
                        "content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn", "usage": {"input_tokens": 9, "output_tokens": 2}}))
                }),
            );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}/v1")
    }

    fn acct(id: &str, base: &str, cap: f64) -> Account {
        Account {
            id: id.into(),
            provider_id: id.into(),
            label: id.into(),
            base_url: base.into(),
            enabled: true,
            margin: 1.0,
            limits: vec![Limit { unit: Unit::Requests, cap, amount: cap, window: Window::Rolling { seconds: 60 }, label: format!("{cap} requests / minute") }],
            added_at: Utc::now(),
            anthropic_base_url: None,
            model_suffix: None,
            models: vec!["m1".into()],
        }
    }

    async fn start(accounts: Vec<Account>) -> (Arc<Gateway>, String) {
        let gw = Gateway::new(accounts, "local-key".into(), Arc::new(Ledger::in_memory().unwrap()), Arc::new(Keys));
        let (addr, _h) = gw.serve(0).await.unwrap();
        (gw, format!("http://{addr}"))
    }

    #[tokio::test]
    async fn requires_local_key() {
        let base = mock_upstream().await;
        let (_gw, url) = start(vec![acct("a", &base, 5.0)]).await;
        let c = reqwest::Client::new();
        let r = c.post(format!("{url}/v1/chat/completions")).json(&json!({"model": "m1"})).send().await.unwrap();
        assert_eq!(r.status(), 401);
        let r = c.post(format!("{url}/v1/chat/completions")).header("x-api-key", "local-key").json(&json!({"model": "m1"})).send().await.unwrap();
        assert_eq!(r.status(), 200);
    }

    #[tokio::test]
    async fn falls_through_to_next_account_and_caps() {
        let base = mock_upstream().await;
        let (gw, url) = start(vec![acct("a", &base, 1.0), acct("b", &base, 1.0)]).await;
        let c = reqwest::Client::new();
        let call = || c.post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "m1", "messages": []})).send();
        assert_eq!(call().await.unwrap().status(), 200); // a
        let v: Value = call().await.unwrap().json().await.unwrap(); // b
        assert_eq!(v["model"], "m1");
        assert_eq!(v["auth"], "Bearer test-key");
        let r = call().await.unwrap();
        assert_eq!(r.status(), 429);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "local_quota_reached");
        let u = gw.usage();
        assert_eq!(u.iter().map(|x| x.today_requests).sum::<u64>(), 2);
        assert_eq!(u.iter().map(|x| x.today_tokens).sum::<u64>(), 20);
    }

    #[tokio::test]
    async fn explicit_account_prefix_and_unknown_model() {
        let base = mock_upstream().await;
        let (_gw, url) = start(vec![acct("a", &base, 5.0)]).await;
        let c = reqwest::Client::new();
        let r = c.post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "a/anything"})).send().await.unwrap();
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["model"], "anything");
        let r = c.post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "nope"})).send().await.unwrap();
        assert_eq!(r.status(), 404);
    }

    #[tokio::test]
    async fn claude_needs_native_endpoint() {
        let base = mock_upstream().await;
        let root = base.trim_end_matches("/v1").to_string();
        let mut native = acct("n", &base, 5.0);
        native.anthropic_base_url = Some(root);
        let (gw, url) = start(vec![acct("a", &base, 5.0), native]).await;
        let c = reqwest::Client::new();
        let body = json!({"model": "m1", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]});
        // Skips account "a" (no native endpoint) and forwards to "n" unchanged.
        let r = c.post(format!("{url}/v1/messages")).header("x-api-key", "local-key").json(&body).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["type"], "message");
        assert_eq!(v["usage"]["input_tokens"], 9);
        assert_eq!(gw.usage()[1].today_tokens, 9 + 2);
        // Pinning an account without a native endpoint is an error, not a conversion.
        let r = c.post(format!("{url}/v1/messages")).header("x-api-key", "local-key").json(&json!({"model": "a/m1", "max_tokens": 5, "messages": []})).send().await.unwrap();
        assert_eq!(r.status(), 400);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["type"], "invalid_request_error");
    }

    fn routes() -> Vec<Route> {
        crate::routing::parse(&json!({"models": [
            {"id": "v/best", "name": "Best", "quality": 90, "tools": false,
             "offers": [{"provider": "a", "model": "boom", "access": "free"}]},
            {"id": "v/good", "name": "Good Model", "quality": 50, "tools": true,
             "offers": [{"provider": "a", "model": "good-a", "access": "quota"}, {"provider": "b", "model": "m1", "access": "free"}]}
        ]}))
    }

    #[tokio::test]
    async fn auto_picks_best_and_moves_on_after_errors() {
        let base = mock_upstream().await;
        let mut a = acct("a", &base, 5.0);
        a.models = vec!["boom".into(), "good-a".into()];
        let (gw, url) = start(vec![a, acct("b", &base, 5.0)]).await;
        gw.set_routes(routes());
        let c = reqwest::Client::new();
        // Best model's provider fails with 500, so the gateway goes on; "Good Model" serves free offers first (b) then quota (a).
        let r = c.post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "auto", "messages": []})).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["x-yangmao-served-by"], "b/m1");
        // Tools needed: "Best" lacks tools and is skipped; a is paused for 30s after the 500.
        let r = c.post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "auto", "tools": [{}], "messages": []})).send().await.unwrap();
        assert_eq!(r.headers()["x-yangmao-served-by"], "b/m1");
        // A model-square name reaches every provider serving it, under their own ids.
        let r = c.post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "Good Model", "messages": []})).send().await.unwrap();
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["model"], "m1");
        // /v1/models lists auto first.
        let v: Value = c.get(format!("{url}/v1/models")).bearer_auth("local-key").send().await.unwrap().json().await.unwrap();
        assert_eq!(v["data"][0]["id"], "auto");
        assert_eq!(gw.routed_models().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["Best", "Good Model"]);
    }

    #[tokio::test]
    async fn single_candidate_returns_upstream_error() {
        let base = mock_upstream().await;
        let mut a = acct("a", &base, 5.0);
        a.models = vec!["boom".into()];
        let (_gw, url) = start(vec![a]).await;
        let r = reqwest::Client::new().post(format!("{url}/v1/chat/completions")).bearer_auth("local-key").json(&json!({"model": "boom"})).send().await.unwrap();
        assert_eq!(r.status(), 500);
    }

    #[tokio::test]
    async fn fetches_models() {
        let base = mock_upstream().await;
        let ids = fetch_models(&reqwest::Client::new(), &base, "k").await.unwrap();
        assert_eq!(ids, vec!["a:free".to_string(), "b".to_string()]);
    }
}

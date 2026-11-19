//! Local OpenAI-compatible gateway.
//!
//! Clients call `http://127.0.0.1:<port>/v1/...` with `model = "<account>/<upstream model>"`.
//! The gateway checks the local limits for that account, forwards the request
//! unchanged (apart from the model name and asking for usage in streams) to the
//! provider with the user's own key, and records usage in the local ledger.

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

pub struct Gateway {
    accounts: RwLock<Vec<Account>>,
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

impl Gateway {
    pub fn new(accounts: Vec<Account>, ledger: Arc<Ledger>, secrets: Arc<dyn SecretStore>) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("YangmaoSwitch/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Arc::new(Self { accounts: RwLock::new(accounts), ledger, secrets, client, reserve: tokio::sync::Mutex::new(()) })
    }

    pub fn set_accounts(&self, accounts: Vec<Account>) {
        *self.accounts.write().unwrap() = accounts;
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    fn account(&self, id: &str) -> Option<Account> {
        self.accounts.read().unwrap().iter().find(|a| a.id == id).cloned()
    }

    /// First limit that would be exceeded by one more request, if any.
    fn exceeded(&self, acct: &Account, now: DateTime<Utc>) -> anyhow::Result<Option<(Limit, u64)>> {
        for l in &acct.limits {
            let t = self.ledger.totals_since(&acct.id, l.window.start(now, acct.added_at))?;
            let used = match l.unit {
                Unit::Requests => t.requests,
                Unit::Tokens => t.tokens,
            };
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
            .route("/v1/{*path}", post(forward))
            .with_state(self.clone())
    }

    /// Bind on 127.0.0.1 only and serve in the background. Returns the bound address.
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

fn error(status: StatusCode, code: &str, message: String) -> Response {
    (status, Json(json!({"error": {"message": message, "type": "yangmao_switch", "code": code}}))).into_response()
}

async fn list_models(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    let accounts = gw.accounts.read().unwrap().clone();
    let data: Vec<Value> = accounts
        .iter()
        .filter(|a| a.enabled)
        .map(|a| json!({"id": format!("{}/<model>", a.id), "object": "model", "owned_by": a.provider_id}))
        .collect();
    Json(json!({"object": "list", "data": data}))
}

fn usage_from(v: &Value) -> Option<(u64, u64)> {
    let u = v.get("usage")?;
    if u.is_null() {
        return None;
    }
    let get = |k: &str| u.get(k).and_then(Value::as_u64);
    let prompt = get("prompt_tokens").or_else(|| get("input_tokens")).unwrap_or(0);
    let completion = get("completion_tokens").or_else(|| get("output_tokens")).unwrap_or(0);
    Some((prompt, completion))
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<i64> {
    headers.get("retry-after")?.to_str().ok()?.trim().parse::<i64>().ok()
}

async fn forward(State(gw): State<Arc<Gateway>>, Path(path): Path<String>, _headers: HeaderMap, body: Bytes) -> Response {
    let mut req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_json", format!("请求体不是合法 JSON：{e}")),
    };
    let Some(model) = req.get("model").and_then(Value::as_str).map(str::to_string) else {
        return error(StatusCode::BAD_REQUEST, "missing_model", "缺少 model 字段，格式为 <账号>/<模型>".into());
    };
    let Some((account_id, upstream_model)) = model.split_once('/') else {
        return error(StatusCode::BAD_REQUEST, "bad_model", format!("model 应写成 <账号>/<模型>，例如 openrouter/xxx:free，收到：{model}"));
    };
    let Some(acct) = gw.account(account_id) else {
        return error(StatusCode::NOT_FOUND, "unknown_account", format!("没有名为 {account_id} 的账号"));
    };
    if !acct.enabled {
        return error(StatusCode::FORBIDDEN, "account_disabled", format!("账号 {account_id} 已停用"));
    }
    let Some(key) = gw.secrets.get(&acct.id) else {
        return error(StatusCode::UNAUTHORIZED, "missing_key", format!("账号 {account_id} 在本机钥匙串里没有 Key"));
    };

    // Check limits and reserve a slot atomically.
    let row = {
        let _guard = gw.reserve.lock().await;
        let now = Utc::now();
        match gw.ledger.blocked_until(&acct.id, now) {
            Ok(Some((until, reason))) => {
                return error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "provider_limited",
                    format!("账号 {account_id} 暂停到 {}（{reason}）", until.to_rfc3339()),
                )
            }
            Ok(None) => {}
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "ledger", e.to_string()),
        }
        match gw.exceeded(&acct, now) {
            Ok(Some((limit, used))) => {
                let reset = limit.window.next_reset(now, acct.added_at).map(|t| format!("，{} 重置", t.to_rfc3339())).unwrap_or_default();
                return error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "local_quota_reached",
                    format!("账号 {account_id} 已用到本地上限：{used}/{}（免费额度 {}，按 {:.0}% 留余量）{reset}", limit.cap, limit.label, acct.margin * 100.0),
                );
            }
            Ok(None) => {}
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "ledger", e.to_string()),
        }
        match gw.ledger.begin(&acct.id, upstream_model, now) {
            Ok(r) => r,
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "ledger", e.to_string()),
        }
    };

    req["model"] = Value::String(upstream_model.to_string());
    let stream = req.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if stream && path.ends_with("chat/completions") && req.get("stream_options").is_none() {
        // Needed to count tokens for streaming responses.
        req["stream_options"] = json!({"include_usage": true});
    }

    let url = format!("{}/{}", acct.base_url, path);
    let resp = match gw.client.post(&url).bearer_auth(&key).json(&req).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = gw.ledger.cancel(row);
            return error(StatusCode::BAD_GATEWAY, "upstream_unreachable", format!("连接 {} 失败：{e}", acct.base_url));
        }
    };

    let status = resp.status();
    let now = Utc::now();
    if status.as_u16() == 429 {
        let secs = retry_after(resp.headers()).unwrap_or(60);
        let _ = gw.ledger.block(&acct.id, now + Duration::seconds(secs), "平台返回 429");
        let _ = gw.ledger.cancel(row);
    } else if status.as_u16() == 402 {
        let _ = gw.ledger.block(&acct.id, now + Duration::hours(1), "平台返回 402（额度或余额不足）");
        let _ = gw.ledger.cancel(row);
    } else if !status.is_success() {
        let _ = gw.ledger.cancel(row);
    }

    let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    let out_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    if !status.is_success() || !stream {
        let bytes = resp.bytes().await.unwrap_or_default();
        if status.is_success() {
            let (p, c) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| usage_from(&v)).unwrap_or((0, 0));
            let _ = gw.ledger.finish(row, status.as_u16(), p, c);
        }
        return Response::builder().status(out_status).header(header::CONTENT_TYPE, content_type).body(Body::from(bytes)).unwrap();
    }

    // Streaming: pass bytes through and pick usage out of the SSE events.
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    let gw2 = gw.clone();
    let code = status.as_u16();
    tokio::spawn(async move {
        let mut upstream = resp.bytes_stream();
        let mut buf = String::new();
        let mut usage = (0u64, 0u64);
        while let Some(chunk) = upstream.next().await {
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
        let _ = gw2.ledger.finish(row, code, usage.0, usage.1);
    });
    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (c, rx)) }));
    Response::builder().status(out_status).header(header::CONTENT_TYPE, content_type).body(body).unwrap()
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
        let app = Router::new().route(
            "/v1/chat/completions",
            post(|Json(v): Json<Value>| async move {
                Json(json!({"id": "x", "model": v["model"], "choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}))
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}/v1")
    }

    #[tokio::test]
    async fn enforces_request_cap_and_records_tokens() {
        let base = mock_upstream().await;
        let acct = Account {
            id: "demo".into(),
            provider_id: "demo".into(),
            label: "Demo".into(),
            base_url: base,
            enabled: true,
            margin: 1.0,
            limits: vec![Limit { unit: Unit::Requests, cap: 2.0, amount: 2.0, window: Window::Rolling { seconds: 60 }, label: "2 requests / minute".into() }],
            added_at: Utc::now(),
        };
        let gw = Gateway::new(vec![acct], Arc::new(Ledger::in_memory().unwrap()), Arc::new(Keys));
        let (addr, _h) = gw.serve(0).await.unwrap();
        let c = reqwest::Client::new();
        let url = format!("http://{addr}/v1/chat/completions");
        let body = json!({"model": "demo/some-model:free", "messages": []});
        for _ in 0..2 {
            let r = c.post(&url).json(&body).send().await.unwrap();
            assert_eq!(r.status(), 200);
            let v: Value = r.json().await.unwrap();
            assert_eq!(v["model"], "some-model:free");
        }
        let r = c.post(&url).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 429);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "local_quota_reached");
        let u = &gw.usage()[0];
        assert_eq!(u.today_requests, 2);
        assert_eq!(u.today_tokens, 20);
    }

    #[tokio::test]
    async fn rejects_unknown_account() {
        let gw = Gateway::new(vec![], Arc::new(Ledger::in_memory().unwrap()), Arc::new(Keys));
        let (addr, _h) = gw.serve(0).await.unwrap();
        let r = reqwest::Client::new()
            .post(format!("http://{addr}/v1/chat/completions"))
            .json(&json!({"model": "nope/x"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);
    }
}

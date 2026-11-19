use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use ym_core::accounts::{self, Account, AccountFile, SecretStore};
use ym_core::catalog::{Catalog, CATALOG_URLS, MODELS_URLS};
use ym_core::gateway::{fetch_models, AccountUsage, Gateway, ModelEntry};
use ym_core::ledger::Ledger;
use ym_core::limits;

const KEYCHAIN_SERVICE: &str = "yangmao-switch";
const DEFAULT_PORT: u16 = 17890;
const BUNDLED_CATALOG: &str = include_str!("../catalog.snapshot.json");
const BUNDLED_MODELS: &str = include_str!("../models.snapshot.json");
const IDENTIFIER: &str = "io.github.yangmaoswitch.app";

/* ---------- keychain ---------- */

struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, account_id: &str) -> Option<String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account_id).ok()?.get_password().ok()
    }
}

fn keychain_set(account_id: &str, key: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account_id)
        .and_then(|e| e.set_password(key))
        .map_err(|e| format!("写入系统钥匙串失败：{e}"))
}

fn keychain_delete(account_id: &str) {
    if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, account_id) {
        let _ = e.delete_credential();
    }
}

/* ---------- settings ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    port: u16,
    api_key: String,
}

fn random_key() -> String {
    use rand::RngCore;
    let mut b = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut b);
    format!("ym-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

impl Settings {
    fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| Settings { port: DEFAULT_PORT, api_key: random_key() })
    }
    fn save(&self, path: &PathBuf) -> Result<(), String> {
        std::fs::write(path, serde_json::to_vec_pretty(self).map_err(s)?).map_err(s)
    }
}

/* ---------- state ---------- */

struct Server {
    addr: Option<SocketAddr>,
    error: Option<String>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

struct AppState {
    data_dir: PathBuf,
    file: AccountFile,
    accounts: Mutex<Vec<Account>>,
    catalog: Mutex<Catalog>,
    settings: Mutex<Settings>,
    gateway: Arc<Gateway>,
    server: Mutex<Server>,
}

impl AppState {
    fn persist(&self, accounts: &[Account]) -> Result<(), String> {
        self.file.save(accounts).map_err(s)?;
        self.gateway.set_accounts(accounts.to_vec());
        Ok(())
    }
    fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }
}

type R<T> = Result<T, String>;

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// (Re)start the gateway on `port`. Never falls back to a random port, so client configs stay valid.
async fn start_server(gw: &Arc<Gateway>, server: &Mutex<Server>, port: u16) -> Result<SocketAddr, String> {
    if let Some(h) = server.lock().unwrap().handle.take() {
        h.abort();
    }
    // Give the OS a moment to release the old socket.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    match gw.serve(port).await {
        Ok((addr, handle)) => {
            *server.lock().unwrap() = Server { addr: Some(addr), error: None, handle: Some(handle) };
            Ok(addr)
        }
        Err(e) => {
            let msg = format!("端口 {port} 无法使用（{e}），请在“接入工具”里换一个端口");
            *server.lock().unwrap() = Server { addr: None, error: Some(msg.clone()), handle: None };
            Err(msg)
        }
    }
}

/// Refresh the model list of one account from the provider.
async fn refresh_models_inner(state: &AppState, id: &str) -> R<usize> {
    let acct = state.accounts.lock().unwrap().iter().find(|a| a.id == id).cloned().ok_or("账号不存在")?;
    let key = Keychain.get(id).ok_or("钥匙串里没有这个账号的 Key")?;
    let ids = fetch_models(state.gateway.client(), &acct.base_url, &key).await.map_err(|e| format!("获取模型列表失败：{e}"))?;
    let mut accounts = state.accounts.lock().unwrap();
    let mut n = 0;
    for a in accounts.iter_mut().filter(|a| a.id == id) {
        a.models = ids.iter().filter(|m| a.keep_model(m)).cloned().collect();
        n = a.models.len();
    }
    state.persist(&accounts)?;
    Ok(n)
}

/* ---------- commands ---------- */

/// Server data older than this is fetched again when a page asks for it.
const SERVER_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// GET the first mirror that answers.
async fn fetch_first(urls: &[&str]) -> R<String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(s)?;
    let mut last = String::new();
    for u in urls {
        match client.get(*u).send().await.and_then(|r| r.error_for_status()) {
            Ok(r) => match r.text().await {
                Ok(t) => return Ok(t),
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("服务器不可用：{last}"))
}

fn fresh(path: &std::path::Path) -> bool {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d < SERVER_TTL)
}

/// Provider catalog from the server; the cached copy (or the bundled snapshot) when the server is unreachable.
/// `refresh` forces a fetch and reports a failure instead of falling back.
#[tauri::command]
async fn get_catalog(state: State<'_, AppState>, refresh: bool) -> R<Catalog> {
    let cache = state.data_dir.join("catalog.json");
    if refresh || !fresh(&cache) {
        let got = fetch_first(CATALOG_URLS).await.and_then(|t| Catalog::from_json(&t).map(|c| (t, c)).map_err(s));
        match got {
            Ok((text, cat)) => {
                std::fs::write(&cache, &text).map_err(s)?;
                *state.catalog.lock().unwrap() = cat.clone();
                return Ok(cat);
            }
            Err(e) if refresh => return Err(e),
            Err(_) => {}
        }
    }
    Ok(state.catalog.lock().unwrap().clone())
}

/// Model square data from the server (every platform's models, free / quota / paid);
/// the cached copy, then the bundled snapshot, when the server is unreachable.
#[tauri::command]
async fn get_model_square(state: State<'_, AppState>, refresh: bool) -> R<serde_json::Value> {
    let cache = state.data_dir.join("models.json");
    if refresh || !fresh(&cache) {
        let got = fetch_first(MODELS_URLS).await.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map(|v| (t, v)).map_err(s));
        match got {
            Ok((text, v)) => {
                std::fs::write(&cache, &text).map_err(s)?;
                return Ok(v);
            }
            Err(e) if refresh => return Err(e),
            Err(_) => {}
        }
    }
    let text = std::fs::read_to_string(&cache).unwrap_or_else(|_| BUNDLED_MODELS.to_string());
    serde_json::from_str(&text).map_err(s)
}

#[tauri::command]
fn list_accounts(state: State<'_, AppState>) -> Vec<Account> {
    state.accounts.lock().unwrap().clone()
}

fn add_account_inner(state: &AppState, provider_id: &str, key: &str, base_url: Option<String>) -> R<Account> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Key 为空".into());
    }
    let provider = state.catalog.lock().unwrap().provider(provider_id).cloned().ok_or_else(|| format!("目录里没有 {provider_id}"))?;
    let mut accounts = state.accounts.lock().unwrap();
    let id = accounts::next_id(provider_id, &accounts);
    let acct = Account::from_provider(id, &provider, base_url.filter(|b| !b.trim().is_empty()), 0.9).map_err(s)?;
    keychain_set(&acct.id, key)?;
    accounts.push(acct.clone());
    state.persist(&accounts)?;
    Ok(acct)
}

#[tauri::command]
async fn add_account(state: State<'_, AppState>, provider_id: String, key: String, base_url: Option<String>) -> R<Account> {
    let acct = add_account_inner(&state, &provider_id, &key, base_url)?;
    let _ = refresh_models_inner(&state, &acct.id).await;
    Ok(state.accounts.lock().unwrap().iter().find(|a| a.id == acct.id).cloned().unwrap_or(acct))
}

#[tauri::command]
fn remove_account(state: State<'_, AppState>, id: String) -> R<()> {
    let mut accounts = state.accounts.lock().unwrap();
    accounts.retain(|a| a.id != id);
    keychain_delete(&id);
    let _ = state.gateway.ledger().clear_account(&id);
    state.persist(&accounts)
}

#[tauri::command]
fn set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> R<()> {
    let mut accounts = state.accounts.lock().unwrap();
    accounts.iter_mut().filter(|a| a.id == id).for_each(|a| a.enabled = enabled);
    state.persist(&accounts)
}

#[tauri::command]
fn set_margin(state: State<'_, AppState>, id: String, margin: f64) -> R<()> {
    let catalog = state.catalog.lock().unwrap().clone();
    let mut accounts = state.accounts.lock().unwrap();
    for a in accounts.iter_mut().filter(|a| a.id == id) {
        a.margin = margin.clamp(0.05, 1.0);
        if let Some(p) = catalog.provider(&a.provider_id) {
            a.limits = limits::derive(&p.quotas, a.margin);
        }
    }
    state.persist(&accounts)
}

/// Move an account up/down; earlier accounts are tried first.
#[tauri::command]
fn move_account(state: State<'_, AppState>, id: String, delta: i32) -> R<()> {
    let mut accounts = state.accounts.lock().unwrap();
    let Some(i) = accounts.iter().position(|a| a.id == id) else { return Ok(()) };
    let j = (i as i32 + delta).clamp(0, accounts.len() as i32 - 1) as usize;
    accounts.swap(i, j);
    state.persist(&accounts)
}

#[tauri::command]
async fn test_account(state: State<'_, AppState>, id: String) -> R<String> {
    let n = refresh_models_inner(&state, &id).await?;
    Ok(format!("连接正常，可用模型 {n} 个"))
}

#[tauri::command]
async fn refresh_models(state: State<'_, AppState>, id: String) -> R<usize> {
    refresh_models_inner(&state, &id).await
}

#[tauri::command]
fn list_models(state: State<'_, AppState>) -> Vec<ModelEntry> {
    state.gateway.models()
}

#[tauri::command]
fn usage(state: State<'_, AppState>) -> Vec<AccountUsage> {
    state.gateway.usage()
}

#[tauri::command]
fn recent_requests(state: State<'_, AppState>, limit: u32) -> R<Vec<ym_core::ledger::UsageRow>> {
    state.gateway.ledger().recent(limit.min(500)).map_err(s)
}

#[derive(Serialize)]
struct GatewayInfo {
    running: bool,
    base_url: Option<String>,
    port: u16,
    api_key: String,
    error: Option<String>,
}

fn info(state: &AppState) -> GatewayInfo {
    let srv = state.server.lock().unwrap();
    let st = state.settings.lock().unwrap();
    GatewayInfo {
        running: srv.addr.is_some(),
        base_url: srv.addr.map(|a| format!("http://{a}")),
        port: st.port,
        api_key: st.api_key.clone(),
        error: srv.error.clone(),
    }
}

#[tauri::command]
fn gateway_info(state: State<'_, AppState>) -> GatewayInfo {
    info(&state)
}

#[tauri::command]
async fn set_port(state: State<'_, AppState>, port: u16) -> R<GatewayInfo> {
    if port < 1024 {
        return Err("请使用 1024 以上的端口".into());
    }
    start_server(&state.gateway, &state.server, port).await?;
    let mut st = state.settings.lock().unwrap().clone();
    st.port = port;
    st.save(&state.settings_path())?;
    *state.settings.lock().unwrap() = st;
    Ok(info(&state))
}

#[tauri::command]
fn set_api_key(state: State<'_, AppState>, key: Option<String>) -> R<GatewayInfo> {
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).unwrap_or_else(random_key);
    if key.len() < 8 {
        return Err("API Key 至少 8 个字符".into());
    }
    let mut st = state.settings.lock().unwrap().clone();
    st.api_key = key.clone();
    st.save(&state.settings_path())?;
    *state.settings.lock().unwrap() = st;
    state.gateway.set_api_key(key);
    Ok(info(&state))
}

#[tauri::command]
async fn connect_openrouter(app: tauri::AppHandle, state: State<'_, AppState>) -> R<Account> {
    let opener = app.clone();
    let key = ym_core::oauth::openrouter_connect(move |url| {
        let _ = opener.opener().open_url(url, None::<&str>);
    })
    .await
    .map_err(s)?;
    let acct = add_account_inner(&state, "openrouter", &key, None)?;
    let _ = refresh_models_inner(&state, &acct.id).await;
    Ok(acct)
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> R<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开网页链接".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(s)
}

/* ---------- uninstall helper ---------- */

fn data_dir_without_tauri() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(IDENTIFIER))
}

/// Remove every stored key from the OS keychain (used by the uninstaller).
pub fn purge_keys() {
    let Some(dir) = data_dir_without_tauri() else { return };
    for a in AccountFile::new(dir.join("accounts.json")).load().unwrap_or_default() {
        keychain_delete(&a.id);
    }
}

/* ---------- entry ---------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let catalog = std::fs::read_to_string(data_dir.join("catalog.json"))
                .ok()
                .and_then(|t| Catalog::from_json(&t).ok())
                .unwrap_or_else(|| Catalog::from_json(BUNDLED_CATALOG).expect("bundled catalog"));

            let settings_path = data_dir.join("settings.json");
            let settings = Settings::load(&settings_path);
            settings.save(&settings_path).ok();

            let file = AccountFile::new(data_dir.join("accounts.json"));
            let accounts = file.load().unwrap_or_default();
            let ledger = Arc::new(Ledger::open(&data_dir.join("usage.db"))?);
            let gateway = Gateway::new(accounts.clone(), settings.api_key.clone(), ledger, Arc::new(Keychain));

            let state = AppState {
                data_dir,
                file,
                accounts: Mutex::new(accounts.clone()),
                catalog: Mutex::new(catalog),
                settings: Mutex::new(settings.clone()),
                gateway: gateway.clone(),
                server: Mutex::new(Server { addr: None, error: None, handle: None }),
            };
            app.manage(state);

            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                let st = handle.state::<AppState>();
                let _ = start_server(&st.gateway, &st.server, settings.port).await;
            });
            // Refresh model lists in the background.
            tauri::async_runtime::spawn(async move {
                let st = handle.state::<AppState>();
                for a in accounts {
                    let _ = refresh_models_inner(&st, &a.id).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_catalog,
            get_model_square,
            list_accounts,
            add_account,
            remove_account,
            set_enabled,
            set_margin,
            move_account,
            test_account,
            refresh_models,
            list_models,
            usage,
            recent_requests,
            gateway_info,
            set_port,
            set_api_key,
            connect_openrouter,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running YangmaoSwitch");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_roundtrip() {
        let id = "ym-selftest";
        keychain_set(id, "sk-test-123").unwrap();
        assert_eq!(Keychain.get(id).as_deref(), Some("sk-test-123"));
        keychain_delete(id);
        assert_eq!(Keychain.get(id), None);
    }

    #[test]
    fn bundled_catalog_parses() {
        let c = Catalog::from_json(BUNDLED_CATALOG).unwrap();
        assert!(c.provider("openrouter").is_some());
    }

    #[test]
    fn random_key_shape() {
        let k = random_key();
        assert!(k.starts_with("ym-") && k.len() == 39);
    }
}

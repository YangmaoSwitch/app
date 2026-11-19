use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use ym_core::accounts::{self, Account, AccountFile, SecretStore};
use ym_core::catalog::{Catalog, CATALOG_URL};
use ym_core::gateway::{AccountUsage, Gateway};
use ym_core::ledger::Ledger;
use ym_core::limits;

const KEYCHAIN_SERVICE: &str = "yangmao-switch";
const DEFAULT_PORT: u16 = 17890;
const BUNDLED_CATALOG: &str = include_str!("../catalog.snapshot.json");

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

struct AppState {
    data_dir: PathBuf,
    file: AccountFile,
    accounts: Mutex<Vec<Account>>,
    catalog: Mutex<Catalog>,
    gateway: Arc<Gateway>,
    addr: Mutex<Option<SocketAddr>>,
}

impl AppState {
    fn persist(&self, accounts: &[Account]) -> Result<(), String> {
        self.file.save(accounts).map_err(|e| e.to_string())?;
        self.gateway.set_accounts(accounts.to_vec());
        Ok(())
    }
}

type R<T> = Result<T, String>;

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
async fn get_catalog(state: State<'_, AppState>, refresh: bool) -> R<Catalog> {
    let cache = state.data_dir.join("catalog.json");
    if refresh {
        let text = reqwest::get(CATALOG_URL).await.map_err(s)?.error_for_status().map_err(s)?.text().await.map_err(s)?;
        let cat = Catalog::from_json(&text).map_err(s)?;
        std::fs::write(&cache, &text).map_err(s)?;
        *state.catalog.lock().unwrap() = cat.clone();
        return Ok(cat);
    }
    Ok(state.catalog.lock().unwrap().clone())
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
    let base_url = base_url.filter(|b| !b.trim().is_empty());
    let acct = Account::from_provider(id, &provider, base_url, 0.9).map_err(s)?;
    keychain_set(&acct.id, key)?;
    accounts.push(acct.clone());
    state.persist(&accounts)?;
    Ok(acct)
}

#[tauri::command]
fn add_account(state: State<'_, AppState>, provider_id: String, key: String, base_url: Option<String>) -> R<Account> {
    add_account_inner(&state, &provider_id, &key, base_url)
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

#[tauri::command]
async fn test_account(state: State<'_, AppState>, id: String) -> R<String> {
    let acct = state.accounts.lock().unwrap().iter().find(|a| a.id == id).cloned().ok_or("账号不存在")?;
    let key = Keychain.get(&id).ok_or("钥匙串里没有这个账号的 Key")?;
    let r = reqwest::Client::new().get(format!("{}/models", acct.base_url)).bearer_auth(key).send().await.map_err(s)?;
    let status = r.status();
    if status.is_success() {
        Ok(format!("连接正常（HTTP {}）", status.as_u16()))
    } else {
        Err(format!("平台返回 HTTP {}", status.as_u16()))
    }
}

#[tauri::command]
fn usage(state: State<'_, AppState>) -> Vec<AccountUsage> {
    state.gateway.usage()
}

#[derive(Serialize)]
struct GatewayInfo {
    running: bool,
    base_url: Option<String>,
}

#[tauri::command]
fn gateway_info(state: State<'_, AppState>) -> GatewayInfo {
    let addr = *state.addr.lock().unwrap();
    GatewayInfo { running: addr.is_some(), base_url: addr.map(|a| format!("http://{a}/v1")) }
}

#[tauri::command]
async fn connect_openrouter(app: tauri::AppHandle, state: State<'_, AppState>) -> R<Account> {
    let opener = app.clone();
    let key = ym_core::oauth::openrouter_connect(move |url| {
        let _ = opener.opener().open_url(url, None::<&str>);
    })
    .await
    .map_err(s)?;
    add_account_inner(&state, "openrouter", &key, None)
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> R<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开网页链接".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(s)
}

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

            let file = AccountFile::new(data_dir.join("accounts.json"));
            let accounts = file.load().unwrap_or_default();
            let ledger = Arc::new(Ledger::open(&data_dir.join("usage.db"))?);
            let gateway = Gateway::new(accounts.clone(), ledger, Arc::new(Keychain));

            let gw = gateway.clone();
            let addr = tauri::async_runtime::block_on(async move {
                match gw.serve(DEFAULT_PORT).await {
                    Ok((a, _)) => Some(a),
                    Err(_) => gw.serve(0).await.ok().map(|(a, _)| a),
                }
            });

            app.manage(AppState {
                data_dir,
                file,
                accounts: Mutex::new(accounts),
                catalog: Mutex::new(catalog),
                gateway,
                addr: Mutex::new(addr),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_catalog,
            list_accounts,
            add_account,
            remove_account,
            set_enabled,
            set_margin,
            test_account,
            usage,
            gateway_info,
            connect_openrouter,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running YangmaoSwitch");
}

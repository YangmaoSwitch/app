//! OAuth 2.0 PKCE with a loopback redirect (RFC 7636 + RFC 8252).

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>YangmaoSwitch</title>\
<body style=\"font-family:sans-serif;text-align:center;padding-top:20vh\">\
<h2>授权完成，可以关闭此页面，回到羊毛switch。</h2><p>Authorized. You can close this tab.</p>";

/// Random one-off callback path such as `/callback/Xy...`: other local processes cannot guess it,
/// so they cannot hand the app a code or token of their own while it waits.
pub fn callback_path() -> String {
    let mut bytes = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("/callback/{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// Wait for one `GET <path>?...` on the listener and return its query parameters.
/// Requests to any other path get a 404 and are ignored.
pub async fn wait_callback(listener: TcpListener, path: &str, timeout: Duration) -> anyhow::Result<Vec<(String, String)>> {
    let fut = async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await?;
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
            if target.split('?').next() != Some(path) {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let body = DONE_PAGE.as_bytes();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.write_all(body).await;
            let url = url::Url::parse(&format!("http://localhost{target}"))?;
            return Ok::<_, anyhow::Error>(url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect());
        }
    };
    tokio::time::timeout(timeout, fut).await.map_err(|_| anyhow::anyhow!("等待授权超时"))?
}

/// OpenRouter: user authorises in the browser, we receive a code on the loopback
/// address and exchange it for an API key that belongs to the user's account.
/// `open` should open the URL in the system browser.
pub async fn openrouter_connect(open: impl FnOnce(String)) -> anyhow::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let p = pkce();
    let path = callback_path();
    let callback = format!("http://127.0.0.1:{port}{path}");
    let mut auth = url::Url::parse("https://openrouter.ai/auth")?;
    auth.query_pairs_mut()
        .append_pair("callback_url", &callback)
        .append_pair("code_challenge", &p.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("key_label", "YangmaoSwitch")
        // Prefill a tiny credit limit: free models cost nothing, paid usage stays capped.
        .append_pair("limit", "0.01");
    open(auth.to_string());

    let params = wait_callback(listener, &path, Duration::from_secs(600)).await?;
    let code = params.iter().find(|(k, _)| k == "code").map(|(_, v)| v.clone()).ok_or_else(|| anyhow::anyhow!("回调里没有 code，可能取消了授权"))?;

    let resp: serde_json::Value = reqwest::Client::new()
        .post("https://openrouter.ai/api/v1/auth/keys")
        .json(&serde_json::json!({"code": code, "code_verifier": p.verifier, "code_challenge_method": "S256"}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    resp.get("key").and_then(|k| k.as_str()).map(str::to_string).ok_or_else(|| anyhow::anyhow!("OpenRouter 没有返回 key"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_shape() {
        let p = pkce();
        assert_eq!(p.verifier.len(), 43);
        assert_eq!(p.challenge.len(), 43);
        assert_ne!(p.verifier, p.challenge);
    }

    #[tokio::test]
    async fn callback_parses_code() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let path = callback_path();
        assert!(path.starts_with("/callback/") && path.len() > 30);
        let h = tokio::spawn({
            let path = path.clone();
            async move { wait_callback(l, &path, Duration::from_secs(5)).await }
        });
        let c = reqwest::Client::new();
        let _ = c.get(format!("http://127.0.0.1:{port}/favicon.ico")).send().await;
        // a guessed or plain callback path is refused
        let r = c.get(format!("http://127.0.0.1:{port}/callback?code=evil")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        let r = c.get(format!("http://127.0.0.1:{port}{path}?code=abc&state=s")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let params = h.await.unwrap().unwrap();
        assert!(params.contains(&("code".into(), "abc".into())));
        assert!(!params.contains(&("code".into(), "evil".into())));
    }
}

//! The whole flow over HTTP, with a passkey in software standing in for a phone.

use std::os::unix::fs::PermissionsExt;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::routing::post;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::webauthn::tests::{ORIGIN, SoftPasskey};
use super::*;

const RP_ID: &str = "tally.example.ts.net";
const UP_UV: u8 = 0x05;

struct Harness {
    _dir: tempfile::TempDir,
    auth: Auth,
    app: Router,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let auth = Auth::new(dir.path().join("passkey.json"));
        let api = Router::new().route("/finance.AccountService/ListAccounts", post(|| async { "data" }));
        let app = auth.protect(api).merge(auth.routes());
        Self { _dir: dir, auth, app }
    }

    async fn call(&self, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> (StatusCode, HeaderMap, Value) {
        self.call_from(ORIGIN, method, path, cookie, body).await
    }

    async fn call_from(
        &self,
        origin: &str,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut req = Request::builder().method(method).uri(path).header(header::ORIGIN, origin);
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(b) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self.app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into()));
        (parts.status, parts.headers, json)
    }

    async fn state(&self, cookie: Option<&str>) -> String {
        self.call("GET", "/auth/status", cookie, None).await.2["state"].as_str().unwrap().to_owned()
    }

    async fn challenge(&self) -> (Vec<u8>, Value) {
        let (status, _, body) = self.call("POST", "/auth/challenge", None, None).await;
        assert_eq!(status, StatusCode::OK);
        (b64(body["challenge"].as_str().unwrap()).unwrap(), body["credentials"].clone())
    }

    async fn register(&self, p: &SoftPasskey) -> (StatusCode, Option<String>, Value) {
        let (challenge, _) = self.challenge().await;
        let (status, headers, body) = self.call("POST", "/auth/register", None, Some(registration(p, ORIGIN, &challenge))).await;
        (status, cookie(&headers), body)
    }

    async fn login(&self, p: &SoftPasskey) -> (StatusCode, Option<String>, Value) {
        let (challenge, _) = self.challenge().await;
        let (status, headers, body) = self.call("POST", "/auth/login", None, Some(assertion(p, &challenge))).await;
        (status, cookie(&headers), body)
    }

    /// The gRPC status of an API call: 0 is OK, 16 is unauthenticated.
    async fn api(&self, cookie: Option<&str>) -> u32 {
        let (status, headers, _) = self.call("POST", "/finance.AccountService/ListAccounts", cookie, None).await;
        assert_eq!(status, StatusCode::OK);
        headers.get("grpc-status").map_or(0, |v| v.to_str().unwrap().parse().unwrap())
    }
}

fn registration(p: &SoftPasskey, origin: &str, challenge: &[u8]) -> Value {
    let s = p.sign("webauthn.create", origin, RP_ID, challenge, UP_UV);
    json!({
        "id": URL_SAFE_NO_PAD.encode(&p.id),
        "publicKey": URL_SAFE_NO_PAD.encode(p.public_key()),
        "clientDataJson": URL_SAFE_NO_PAD.encode(&s.client_data_json),
        "authenticatorData": URL_SAFE_NO_PAD.encode(&s.authenticator_data),
    })
}

fn assertion(p: &SoftPasskey, challenge: &[u8]) -> Value {
    let s = p.sign("webauthn.get", ORIGIN, RP_ID, challenge, UP_UV);
    json!({
        "id": URL_SAFE_NO_PAD.encode(&p.id),
        "clientDataJson": URL_SAFE_NO_PAD.encode(&s.client_data_json),
        "authenticatorData": URL_SAFE_NO_PAD.encode(&s.authenticator_data),
        "signature": URL_SAFE_NO_PAD.encode(&s.signature),
    })
}

/// `name=value` from a `Set-Cookie` header, as a browser would send it back.
fn cookie(headers: &HeaderMap) -> Option<String> {
    let set = headers.get(header::SET_COOKIE)?.to_str().unwrap();
    Some(set.split(';').next().unwrap().to_owned()).filter(|c| !c.ends_with('='))
}

#[tokio::test]
async fn setup_then_sign_in() {
    let h = Harness::new();
    assert_eq!(h.state(None).await, "setup");
    assert_eq!(h.api(None).await, 16);

    let phone = SoftPasskey::new(7);
    let (status, cookie, _) = h.register(&phone).await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.expect("setting up signs you in");
    assert_eq!(h.state(Some(&cookie)).await, "signed-in");
    assert_eq!(h.api(Some(&cookie)).await, 0);
    assert_eq!(h.api(None).await, 16);
    assert_eq!(h.state(None).await, "signed-out");

    // Readable only by Tally, and it names the page it was made on.
    let meta = std::fs::metadata(h.auth.path()).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    let saved: Value = serde_json::from_slice(&std::fs::read(h.auth.path()).unwrap()).unwrap();
    assert_eq!(saved["origin"], ORIGIN);

    // A second device signs in with the same (synced) passkey.
    let (_, credentials) = h.challenge().await;
    assert_eq!(credentials, json!([URL_SAFE_NO_PAD.encode(&phone.id)]));
    let (status, cookie, _) = h.login(&phone).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h.api(cookie.as_deref()).await, 0);
}

#[tokio::test]
async fn only_the_first_passkey_is_kept() {
    let h = Harness::new();
    h.register(&SoftPasskey::new(7)).await;
    let (status, cookie, body) = h.register(&SoftPasskey::new(8)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(cookie.is_none());
    assert!(body["error"].as_str().unwrap().contains("delete"));
    // And another passkey can't sign in.
    let (status, cookie, _) = h.login(&SoftPasskey::new(8)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(cookie.is_none());
}

#[tokio::test]
async fn deleting_the_file_signs_everyone_out_and_allows_setup_again() {
    let h = Harness::new();
    let (_, old, _) = h.register(&SoftPasskey::new(7)).await;
    std::fs::remove_file(h.auth.path()).unwrap();
    assert_eq!(h.state(old.as_deref()).await, "setup");
    assert_eq!(h.api(old.as_deref()).await, 16);

    let (status, new, _) = h.register(&SoftPasskey::new(8)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h.api(new.as_deref()).await, 0);
    // The old session was signed with the old file's key.
    assert_eq!(h.api(old.as_deref()).await, 16);
}

#[tokio::test]
async fn sign_in_must_come_from_the_setup_page() {
    let h = Harness::new();
    let phone = SoftPasskey::new(7);
    h.register(&phone).await;
    let (challenge, _) = h.challenge().await;
    let body = assertion(&phone, &challenge);
    let (status, headers, _) = h.call_from("https://evil.example.ts.net", "POST", "/auth/login", None, Some(body)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(headers.get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn a_challenge_works_once() {
    let h = Harness::new();
    let phone = SoftPasskey::new(7);
    h.register(&phone).await;
    let (challenge, _) = h.challenge().await;
    let body = assertion(&phone, &challenge);
    let (first, ..) = h.call("POST", "/auth/login", None, Some(body.clone())).await;
    let (replay, _, err) = h.call("POST", "/auth/login", None, Some(body)).await;
    assert_eq!(first, StatusCode::OK);
    assert_eq!(replay, StatusCode::UNAUTHORIZED);
    assert!(err["error"].as_str().unwrap().contains("already used"));
}

#[tokio::test]
async fn setup_needs_https_or_localhost() {
    let h = Harness::new();
    let (challenge, _) = h.challenge().await;
    let origin = "http://tally.example.ts.net";
    let body = registration(&SoftPasskey::new(7), origin, &challenge);
    let (status, ..) = h.call_from(origin, "POST", "/auth/register", None, Some(body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!h.auth.path().exists());
}

#[tokio::test]
async fn logout_clears_the_cookie() {
    let h = Harness::new();
    h.register(&SoftPasskey::new(7)).await;
    let (status, headers, _) = h.call("POST", "/auth/logout", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let set = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set.starts_with("tally_session=;") && set.contains("Max-Age=0"));
}

#[tokio::test]
async fn cookies_are_strict_http_only_and_secure_on_https() {
    let h = Harness::new();
    let (challenge, _) = h.challenge().await;
    let body = registration(&SoftPasskey::new(7), ORIGIN, &challenge);
    let (_, headers, _) = h.call("POST", "/auth/register", None, Some(body)).await;
    let set = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    for part in ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"] {
        assert!(set.contains(part), "{set} lacks {part}");
    }
}

//! Passkey sign-in, turned on by `PASSKEY_FILE`.
//!
//! With no file there, Tally shows a setup screen, and the first passkey made on it is saved to the
//! file with the page's web address and a key for signing session cookies. Every API call then
//! needs a session. Deleting the file signs every device out and brings the setup screen back.
//! Anyone who can reach Tally before setup can claim it, so keep it on a network only you are on.

mod session;
mod webauthn;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncWriteExt;

const CHALLENGE_LIFETIME: Duration = Duration::from_secs(5 * 60);
/// Plenty for one person; stops a stuck script from growing the map without end.
const MAX_OPEN_CHALLENGES: usize = 64;

#[derive(Clone)]
pub struct Auth(Arc<Inner>);

struct Inner {
    path: PathBuf,
    challenges: Mutex<HashMap<[u8; 32], Instant>>,
    /// Held while setting up, so two browsers can't both claim Tally.
    setup: tokio::sync::Mutex<()>,
}

/// The passkey file. Read on every request, so deleting it takes effect at once.
#[derive(Serialize, Deserialize)]
struct Saved {
    /// The page the passkey was made on; sign-ins must come from it.
    origin: String,
    session_key: String,
    passkeys: Vec<SavedPasskey>,
}

#[derive(Serialize, Deserialize)]
struct SavedPasskey {
    id: String,
    public_key: String,
    created: String,
}

impl Saved {
    fn session_key(&self) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(&self.session_key).unwrap_or_default()
    }

    fn signed_in(&self, headers: &HeaderMap) -> bool {
        let key = self.session_key();
        !key.is_empty()
            && session::from_headers(headers).is_some_and(|t| session::token_is_valid(&key, t, now()))
    }
}

impl Auth {
    pub fn new(path: PathBuf) -> Self {
        Self(Arc::new(Inner { path, challenges: Mutex::default(), setup: tokio::sync::Mutex::new(()) }))
    }

    pub fn path(&self) -> &Path {
        &self.0.path
    }

    /// Wraps the API so every call needs a session.
    pub fn protect(&self, api: Router) -> Router {
        api.layer(axum::middleware::from_fn_with_state(self.clone(), require_session))
    }

    /// `/auth/*`, for the sign-in and setup screens.
    pub fn routes(&self) -> Router {
        Router::new()
            .route("/auth/status", get(status))
            .route("/auth/challenge", post(challenge))
            .route("/auth/register", post(register))
            .route("/auth/login", post(login))
            .route("/auth/logout", post(logout))
            .with_state(self.clone())
    }

    /// `/auth/status` when passkeys are off, so the app knows not to ask for one.
    pub fn off_routes() -> Router {
        Router::new().route("/auth/status", get(|| async { Json(json!({ "state": "off" })) }))
    }

    async fn load(&self) -> Result<Option<Saved>, Unreadable> {
        match tokio::fs::read(&self.0.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
                tracing::error!(path = %self.0.path.display(), error = %e, "the passkey file is damaged");
                Unreadable("The passkey file on the server is damaged. Delete it to set up again.")
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => {
                tracing::error!(path = %self.0.path.display(), error = %e, "can't read the passkey file");
                Err(Unreadable("Tally can't read its passkey file."))
            }
        }
    }

    /// Writes the file whole (a temporary file renamed over it), readable only by Tally.
    async fn save(&self, saved: &Saved) -> std::io::Result<()> {
        let tmp = self.0.path.with_extension("tmp");
        // A leftover from a crash could have other permissions, which `mode` wouldn't change.
        let _ = tokio::fs::remove_file(&tmp).await;
        let mut file = tokio::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).await?;
        file.write_all(&serde_json::to_vec_pretty(saved)?).await?;
        file.sync_all().await?;
        tokio::fs::rename(&tmp, &self.0.path).await
    }

    fn new_challenge(&self) -> Option<[u8; 32]> {
        let mut challenges = self.0.challenges.lock().unwrap();
        challenges.retain(|_, issued| issued.elapsed() < CHALLENGE_LIFETIME);
        if challenges.len() >= MAX_OPEN_CHALLENGES {
            return None;
        }
        let mut challenge = [0u8; 32];
        getrandom::fill(&mut challenge).expect("the OS random number generator failed");
        challenges.insert(challenge, Instant::now());
        Some(challenge)
    }

    /// Uses up a challenge; true if Tally gave it out less than five minutes ago.
    fn take_challenge(&self, challenge: &[u8]) -> bool {
        let Ok(challenge) = <[u8; 32]>::try_from(challenge) else { return false };
        let issued = self.0.challenges.lock().unwrap().remove(&challenge);
        issued.is_some_and(|issued| issued.elapsed() < CHALLENGE_LIFETIME)
    }
}

/// The passkey file is there but can't be used (already logged). Fails closed.
struct Unreadable(&'static str);

impl IntoResponse for Unreadable {
    fn into_response(self) -> Response {
        fail(StatusCode::INTERNAL_SERVER_ERROR, self.0)
    }
}

async fn require_session(State(auth): State<Auth>, req: Request, next: Next) -> Response {
    let message = match auth.load().await {
        Ok(Some(saved)) if saved.signed_in(req.headers()) => return next.run(req).await,
        Ok(Some(_)) => "Sign in with your passkey to use Tally.",
        Ok(None) => "Set up a passkey to use Tally.",
        Err(Unreadable(message)) => return tonic::Status::internal(message).into_http(),
    };
    tonic::Status::unauthenticated(message).into_http()
}

async fn status(State(auth): State<Auth>, headers: HeaderMap) -> Response {
    let state = match auth.load().await {
        Ok(None) => "setup",
        Ok(Some(saved)) if saved.signed_in(&headers) => "signed-in",
        Ok(Some(_)) => "signed-out",
        Err(e) => return e.into_response(),
    };
    Json(json!({ "state": state })).into_response()
}

async fn challenge(State(auth): State<Auth>) -> Response {
    let saved = match auth.load().await {
        Ok(saved) => saved,
        Err(e) => return e.into_response(),
    };
    let Some(challenge) = auth.new_challenge() else {
        return fail(StatusCode::TOO_MANY_REQUESTS, "Too many sign-ins in progress. Wait a few minutes.");
    };
    let credentials: Vec<&str> = saved.iter().flat_map(|s| &s.passkeys).map(|p| p.id.as_str()).collect();
    Json(json!({ "challenge": URL_SAFE_NO_PAD.encode(challenge), "credentials": credentials })).into_response()
}

/// Base64url fields, as the browser's `PublicKeyCredential` gives them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    id: String,
    public_key: String,
    client_data_json: String,
    authenticator_data: String,
}

async fn register(State(auth): State<Auth>, headers: HeaderMap, Json(reg): Json<Registration>) -> Response {
    let _setup = auth.0.setup.lock().await;
    match auth.load().await {
        Ok(None) => {}
        Ok(Some(_)) => {
            let path = auth.path().display();
            return fail(StatusCode::CONFLICT, &format!("Tally already has a passkey. To set it up again, delete {path} on the server."));
        }
        Err(e) => return e.into_response(),
    }
    // The page's own address, which the browser sets and scripts can't. The passkey only works there.
    let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) else {
        return fail(StatusCode::FORBIDDEN, "The request didn't say which page it came from.");
    };
    let Some(rp_id) = webauthn::rp_id(origin) else {
        return fail(StatusCode::BAD_REQUEST, "Passkeys need https (or localhost). Open Tally through `tailscale serve`.");
    };
    let (Some(id), Some(public_key), Some(client_data), Some(authenticator_data)) =
        (b64(&reg.id), b64(&reg.public_key), b64(&reg.client_data_json), b64(&reg.authenticator_data))
    else {
        return fail(StatusCode::BAD_REQUEST, "The browser's passkey data is malformed.");
    };
    let expected = webauthn::Expected { origin, rp_id };
    if let Err(reason) =
        webauthn::verify_registration(&expected, &client_data, &authenticator_data, &public_key, |c| auth.take_challenge(c))
    {
        tracing::warn!(reason, "refused a new passkey");
        return fail(StatusCode::BAD_REQUEST, reason);
    }

    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("the OS random number generator failed");
    let saved = Saved {
        origin: origin.to_owned(),
        session_key: URL_SAFE_NO_PAD.encode(key),
        passkeys: vec![SavedPasskey {
            id: URL_SAFE_NO_PAD.encode(id),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            created: jiff::Timestamp::now().to_string(),
        }],
    };
    if let Err(e) = auth.save(&saved).await {
        tracing::error!(path = %auth.path().display(), error = %e, "can't save the passkey");
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "Tally can't save the passkey on the server.");
    }
    tracing::info!(%origin, "set up a passkey");
    signed_in(&saved, &key)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Assertion {
    id: String,
    client_data_json: String,
    authenticator_data: String,
    signature: String,
}

async fn login(State(auth): State<Auth>, headers: HeaderMap, Json(a): Json<Assertion>) -> Response {
    let saved = match auth.load().await {
        Ok(Some(saved)) => saved,
        Ok(None) => return fail(StatusCode::CONFLICT, "Tally has no passkey yet. Reload to set one up."),
        Err(e) => return e.into_response(),
    };
    // Same-page requests only: a page elsewhere can't sign in on your behalf.
    if headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) != Some(saved.origin.as_str()) {
        return fail(StatusCode::FORBIDDEN, &format!("Open Tally at {} to sign in.", saved.origin));
    }
    let Some(passkey) = saved.passkeys.iter().find(|p| p.id == a.id) else {
        return fail(StatusCode::UNAUTHORIZED, "That passkey isn't the one Tally was set up with.");
    };
    let (Some(public_key), Some(client_data), Some(authenticator_data), Some(signature)) =
        (b64(&passkey.public_key), b64(&a.client_data_json), b64(&a.authenticator_data), b64(&a.signature))
    else {
        return fail(StatusCode::BAD_REQUEST, "The browser's passkey data is malformed.");
    };
    let Some(rp_id) = webauthn::rp_id(&saved.origin) else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "The passkey file on the server is damaged. Delete it to set up again.");
    };
    let expected = webauthn::Expected { origin: &saved.origin, rp_id };
    if let Err(reason) = webauthn::verify_assertion(
        &expected,
        &public_key,
        &client_data,
        &authenticator_data,
        &signature,
        |c| auth.take_challenge(c),
    ) {
        tracing::warn!(reason, "refused a sign-in");
        return fail(StatusCode::UNAUTHORIZED, reason);
    }
    signed_in(&saved, &saved.session_key())
}

async fn logout() -> Response {
    ([(header::SET_COOKIE, session::clear_cookie())], Json(json!({ "state": "signed-out" }))).into_response()
}

fn signed_in(saved: &Saved, key: &[u8]) -> Response {
    let cookie = session::set_cookie(&session::new_token(key, now()), saved.origin.starts_with("https://"));
    ([(header::SET_COOKIE, cookie)], Json(json!({ "state": "signed-in" }))).into_response()
}

fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn b64(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

fn now() -> i64 {
    jiff::Timestamp::now().as_second()
}

#[cfg(test)]
mod tests;

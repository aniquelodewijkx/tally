//! Session cookies. A token is `<expiry>.<nonce>.<mac>`: an HMAC-SHA256 over the expiry and a
//! random nonce, with the key saved next to the passkey. Nothing is stored per session, so the only
//! way to end sessions early is a new key, which setting up a passkey again makes.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const COOKIE: &str = "tally_session";
pub const LIFETIME_SECS: i64 = 30 * 24 * 60 * 60;

pub fn new_token(key: &[u8], now: i64) -> String {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).expect("the OS random number generator failed");
    let payload = format!("{}.{}", now + LIFETIME_SECS, URL_SAFE_NO_PAD.encode(nonce));
    let mac = mac(key, &payload).finalize().into_bytes();
    format!("{payload}.{}", URL_SAFE_NO_PAD.encode(mac))
}

pub fn token_is_valid(key: &[u8], token: &str, now: i64) -> bool {
    let Some((payload, mac_b64)) = token.rsplit_once('.') else { return false };
    let Some(expiry) = payload.split_once('.').and_then(|(e, _)| e.parse::<i64>().ok()) else { return false };
    let Ok(expected) = URL_SAFE_NO_PAD.decode(mac_b64) else { return false };
    // `verify_slice` compares in constant time.
    now < expiry && mac(key, payload).verify_slice(&expected).is_ok()
}

/// The session token from a request's `Cookie` headers, if there is one.
pub fn from_headers(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(COOKIE)?.strip_prefix('='))
}

/// The `Set-Cookie` value for a new session. `Secure` unless the page is on plain-http localhost.
pub fn set_cookie(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{COOKIE}={token}; Path=/; Max-Age={LIFETIME_SECS}; HttpOnly; SameSite=Strict{secure}")
}

pub fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
}

fn mac(key: &[u8], payload: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes keys of any length");
    mac.update(payload.as_bytes());
    mac
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, header};

    use super::*;

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn a_token_is_valid_until_it_expires() {
        let token = new_token(b"key", NOW);
        assert!(token_is_valid(b"key", &token, NOW));
        assert!(token_is_valid(b"key", &token, NOW + LIFETIME_SECS - 1));
        assert!(!token_is_valid(b"key", &token, NOW + LIFETIME_SECS));
    }

    #[test]
    fn a_token_from_another_key_or_changed_is_invalid() {
        let token = new_token(b"key", NOW);
        assert!(!token_is_valid(b"other key", &token, NOW));
        // Pushing the expiry back breaks the MAC.
        let (expiry, rest) = token.split_once('.').unwrap();
        let later = format!("{}.{rest}", expiry.parse::<i64>().unwrap() + 1);
        assert!(!token_is_valid(b"key", &later, NOW));
        for junk in ["", ".", "..", "x.y.z", "1.2"] {
            assert!(!token_is_valid(b"key", junk, NOW));
        }
    }

    #[test]
    fn finds_the_token_among_other_cookies() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("a=1; tally_sessionx=no"));
        headers.append(header::COOKIE, HeaderValue::from_static("b=2; tally_session=tok; c=3"));
        assert_eq!(from_headers(&headers), Some("tok"));
        assert_eq!(from_headers(&HeaderMap::new()), None);
    }
}

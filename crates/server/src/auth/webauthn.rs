//! The two WebAuthn checks Tally needs and nothing more: accepting the first passkey, and checking
//! a sign-in with it. Only ES256 (ECDSA on P-256) keys, which every passkey provider supports.
//!
//! Setup takes the public key the browser reports (`getPublicKey()`) without an attestation:
//! whoever sets Tally up first owns it, so there is nothing for an attestation to prove. Both
//! checks follow WebAuthn Level 3, §7.1 (registration) and §7.2 (authentication).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const USER_PRESENT: u8 = 0x01;
const USER_VERIFIED: u8 = 0x04;

/// Why a passkey was refused. Shown to the person, so it says what to do where it can.
pub type Rejection = &'static str;

/// What the browser's data must match: the page that asked, and the site the passkey belongs to.
pub struct Expected<'a> {
    pub origin: &'a str,
    pub rp_id: &'a str,
}

/// The passkey's site (its "relying party ID") for a page origin: the host name. Plain http only
/// works on localhost, as in browsers. `None` for anything a browser wouldn't make a passkey on.
pub fn rp_id(origin: &str) -> Option<&str> {
    let (secure, rest) = match origin.strip_prefix("https://") {
        Some(rest) => (true, rest),
        None => (false, origin.strip_prefix("http://")?),
    };
    let host = match rest.split_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return None,
        None => rest,
    };
    let valid = !host.is_empty() && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.');
    (valid && (secure || host == "localhost")).then_some(host)
}

/// Checks a new passkey from the setup screen. `take_challenge` must use up a challenge Tally gave
/// out and report whether it was one.
pub fn verify_registration(
    expected: &Expected,
    client_data_json: &[u8],
    authenticator_data: &[u8],
    public_key: &[u8],
    take_challenge: impl FnOnce(&[u8]) -> bool,
) -> Result<(), Rejection> {
    check_client_data(expected, "webauthn.create", client_data_json, take_challenge)?;
    check_authenticator_data(expected, authenticator_data)?;
    VerifyingKey::from_public_key_der(public_key).map_err(|_| "Tally only accepts P-256 (ES256) passkeys.")?;
    Ok(())
}

/// Checks a sign-in: the browser's data, then the signature over it with the stored public key.
pub fn verify_assertion(
    expected: &Expected,
    public_key: &[u8],
    client_data_json: &[u8],
    authenticator_data: &[u8],
    signature: &[u8],
    take_challenge: impl FnOnce(&[u8]) -> bool,
) -> Result<(), Rejection> {
    check_client_data(expected, "webauthn.get", client_data_json, take_challenge)?;
    check_authenticator_data(expected, authenticator_data)?;
    let key = VerifyingKey::from_public_key_der(public_key).map_err(|_| "The saved passkey can't be read.")?;
    let signature = Signature::from_der(signature).map_err(|_| "The passkey's signature is malformed.")?;
    let mut signed = authenticator_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data_json));
    key.verify(&signed, &signature).map_err(|_| "The passkey's signature doesn't match.")
}

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(rename = "crossOrigin", default)]
    cross_origin: bool,
}

fn check_client_data(
    expected: &Expected,
    kind: &str,
    client_data_json: &[u8],
    take_challenge: impl FnOnce(&[u8]) -> bool,
) -> Result<(), Rejection> {
    let data: ClientData = serde_json::from_slice(client_data_json).map_err(|_| "The browser's passkey data is malformed.")?;
    if data.kind != kind {
        return Err("The browser's passkey data is for a different step.");
    }
    if data.origin != expected.origin || data.cross_origin {
        return Err("The passkey was used on a different web address.");
    }
    let challenge = URL_SAFE_NO_PAD.decode(&data.challenge).map_err(|_| "The browser's passkey data is malformed.")?;
    if !take_challenge(&challenge) {
        return Err("This sign-in has expired or was already used. Try again.");
    }
    Ok(())
}

fn check_authenticator_data(expected: &Expected, data: &[u8]) -> Result<(), Rejection> {
    // rpIdHash (32 bytes), flags (1), signature counter (4), then optional extensions.
    if data.len() < 37 {
        return Err("The passkey's data is malformed.");
    }
    if data[..32] != Sha256::digest(expected.rp_id.as_bytes())[..] {
        return Err("The passkey belongs to a different site.");
    }
    let flags = data[32];
    if flags & USER_PRESENT == 0 || flags & USER_VERIFIED == 0 {
        return Err("The passkey didn't confirm it was you (Face ID, fingerprint or PIN).");
    }
    // The signature counter is ignored: synced passkeys always report 0, and the saved passkey is
    // never rewritten after setup.
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use p256::ecdsa::SigningKey;
    use p256::ecdsa::signature::Signer;
    use p256::pkcs8::EncodePublicKey;

    use super::*;

    pub const ORIGIN: &str = "https://tally.example.ts.net";
    const EXPECTED: Expected = Expected { origin: ORIGIN, rp_id: "tally.example.ts.net" };

    /// A passkey in software, standing in for a phone.
    pub struct SoftPasskey {
        key: SigningKey,
        pub id: Vec<u8>,
    }

    pub struct Signed {
        pub client_data_json: Vec<u8>,
        pub authenticator_data: Vec<u8>,
        pub signature: Vec<u8>,
    }

    impl SoftPasskey {
        pub fn new(seed: u8) -> Self {
            let key = SigningKey::from_slice(&[seed; 32]).unwrap();
            Self { key, id: vec![seed; 16] }
        }

        pub fn public_key(&self) -> Vec<u8> {
            self.key.verifying_key().to_public_key_der().unwrap().into_vec()
        }

        /// What a browser and authenticator produce for `navigator.credentials.get/create`.
        pub fn sign(&self, kind: &str, origin: &str, rp_id: &str, challenge: &[u8], flags: u8) -> Signed {
            let client_data_json = serde_json::json!({
                "type": kind,
                "challenge": URL_SAFE_NO_PAD.encode(challenge),
                "origin": origin,
                "crossOrigin": false,
            })
            .to_string()
            .into_bytes();
            let mut authenticator_data = Sha256::digest(rp_id.as_bytes()).to_vec();
            authenticator_data.extend_from_slice(&[flags, 0, 0, 0, 0]);
            let mut signed = authenticator_data.clone();
            signed.extend_from_slice(&Sha256::digest(&client_data_json));
            let signature: Signature = self.key.sign(&signed);
            Signed { client_data_json, authenticator_data, signature: signature.to_der().as_bytes().to_vec() }
        }
    }

    const UP_UV: u8 = USER_PRESENT | USER_VERIFIED;

    fn sign_in(stored: &[u8], s: &Signed) -> Result<(), Rejection> {
        verify_assertion(&EXPECTED, stored, &s.client_data_json, &s.authenticator_data, &s.signature, |c| c == b"challenge")
    }

    #[test]
    fn rp_id_is_the_host_and_needs_https_except_on_localhost() {
        assert_eq!(rp_id("https://tally.example.ts.net"), Some("tally.example.ts.net"));
        assert_eq!(rp_id("https://tally.example.ts.net:8443"), Some("tally.example.ts.net"));
        assert_eq!(rp_id("http://localhost:8080"), Some("localhost"));
        assert_eq!(rp_id("http://tally.example.ts.net"), None);
        assert_eq!(rp_id("http://127.0.0.1:8080"), None);
        assert_eq!(rp_id("https://tally.example.ts.net/x"), None);
        assert_eq!(rp_id("https://tally.example.ts.net:"), None);
        assert_eq!(rp_id("null"), None);
    }

    #[test]
    fn accepts_a_good_sign_in() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.get", ORIGIN, EXPECTED.rp_id, b"challenge", UP_UV);
        assert_eq!(sign_in(&p.public_key(), &s), Ok(()));
    }

    #[test]
    fn accepts_a_high_s_signature() {
        // Authenticators don't normalise ECDSA signatures; (r, n - s) is just as valid.
        let p = SoftPasskey::new(1);
        let mut s = p.sign("webauthn.get", ORIGIN, EXPECTED.rp_id, b"challenge", UP_UV);
        let sig = Signature::from_der(&s.signature).unwrap();
        let (r, low_s) = sig.split_scalars();
        let high = Signature::from_scalars(r.to_bytes(), (-*low_s).to_bytes()).unwrap();
        assert_ne!(high, sig);
        s.signature = high.to_der().as_bytes().to_vec();
        assert_eq!(sign_in(&p.public_key(), &s), Ok(()));
    }

    #[test]
    fn rejects_another_passkeys_signature() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.get", ORIGIN, EXPECTED.rp_id, b"challenge", UP_UV);
        assert_eq!(sign_in(&SoftPasskey::new(2).public_key(), &s), Err("The passkey's signature doesn't match."));
    }

    #[test]
    fn rejects_changed_data() {
        let p = SoftPasskey::new(1);
        let mut s = p.sign("webauthn.get", ORIGIN, EXPECTED.rp_id, b"challenge", UP_UV);
        s.authenticator_data[33] = 1; // the counter, which is covered by the signature
        assert_eq!(sign_in(&p.public_key(), &s), Err("The passkey's signature doesn't match."));
    }

    #[test]
    fn rejects_another_web_address() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.get", "https://evil.example.ts.net", EXPECTED.rp_id, b"challenge", UP_UV);
        assert_eq!(sign_in(&p.public_key(), &s), Err("The passkey was used on a different web address."));
    }

    #[test]
    fn rejects_another_site() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.get", ORIGIN, "example.ts.net", b"challenge", UP_UV);
        assert_eq!(sign_in(&p.public_key(), &s), Err("The passkey belongs to a different site."));
    }

    #[test]
    fn rejects_an_unknown_or_used_challenge() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.get", ORIGIN, EXPECTED.rp_id, b"other", UP_UV);
        assert_eq!(sign_in(&p.public_key(), &s), Err("This sign-in has expired or was already used. Try again."));
    }

    #[test]
    fn rejects_without_user_verification() {
        let p = SoftPasskey::new(1);
        for flags in [USER_PRESENT, USER_VERIFIED, 0] {
            let s = p.sign("webauthn.get", ORIGIN, EXPECTED.rp_id, b"challenge", flags);
            assert!(sign_in(&p.public_key(), &s).unwrap_err().starts_with("The passkey didn't confirm"));
        }
    }

    #[test]
    fn rejects_registration_data_as_a_sign_in() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.create", ORIGIN, EXPECTED.rp_id, b"challenge", UP_UV);
        assert_eq!(sign_in(&p.public_key(), &s), Err("The browser's passkey data is for a different step."));
    }

    #[test]
    fn registration_checks_the_data_and_the_key() {
        let p = SoftPasskey::new(1);
        let s = p.sign("webauthn.create", ORIGIN, EXPECTED.rp_id, b"challenge", UP_UV);
        let register = |key: &[u8]| {
            verify_registration(&EXPECTED, &s.client_data_json, &s.authenticator_data, key, |c| c == b"challenge")
        };
        assert_eq!(register(&p.public_key()), Ok(()));
        assert_eq!(register(b"not a key"), Err("Tally only accepts P-256 (ES256) passkeys."));
    }
}

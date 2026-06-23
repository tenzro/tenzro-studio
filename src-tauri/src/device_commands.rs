//! Device-side passkey + FIDO caBLE Tauri commands.
//!
//! These commands MUST run in the Tauri process because the private key
//! lives in the platform secure enclave (Spec §15.10) and the FIDO caBLE
//! ceremony needs Bluetooth + the CTAP2 stack — neither of which is
//! available in the WebView.
//!
//! The wallet RPC layer (`tenzro_enrollPasskey`, `tenzro_signWithPasskey`,
//! `eth_sendUserOperation`, etc.) is operator-hosted on tenzro-network's
//! RPC nodes. Studio is an RPC client for those; the only thing the
//! Tauri process owns is the device-side ceremony.
//!
//! Lifted from `~/AI/tenzronetwork/apps/tenzro-desktop/src-tauri/src/commands.rs`
//! lines 6443–6562 (verbatim, minus the AppError → String adaptation).
//! Originals stay live in apps/tenzro-desktop until Studio is functionally
//! equivalent and the desktop app is retired.

use serde::{Deserialize, Serialize};

/// Public-key info returned by `device_create_passkey`. The hex is the
/// raw SEC1 uncompressed P-256 pubkey (`x ‖ y`, 64 bytes, no `0x04`
/// prefix) — the same form `tenzro_enrollPasskey` expects in its
/// `passkey_public_key_hex` arg.
#[derive(Debug, Serialize)]
pub struct DeviceKeyInfo {
    pub label: String,
    pub public_key_hex: String,
}

#[tauri::command]
pub async fn device_create_passkey(label: String) -> Result<DeviceKeyInfo, String> {
    let key = tenzro_device_key::create(&label).map_err(|e| e.to_string())?;
    let pk = key.public_key().map_err(|e| e.to_string())?;
    Ok(DeviceKeyInfo {
        label: key.label().to_string(),
        public_key_hex: hex::encode(pk),
    })
}

#[tauri::command]
pub async fn device_sign_with_passkey(
    hb: tauri::State<'_, std::sync::Arc<crate::watchdog::UiHeartbeat>>,
    label: String,
    prehash_hex: String,
) -> Result<String, String> {
    let bytes = hex::decode(prehash_hex.trim_start_matches("0x"))
        .map_err(|e| format!("prehash not hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("prehash must be 32 bytes, got {}", bytes.len()));
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&bytes);

    // Signing triggers the native Touch ID prompt, which blocks the WebView
    // thread (and its watchdog ping) until the user authenticates. Pause the
    // heartbeat timeout for the duration so a slow prompt doesn't get the app
    // killed mid-authentication.
    let _pause = hb.pause();
    let key = tenzro_device_key::open(&label).map_err(|e| e.to_string())?;
    let sig = key.sign_prehash(&digest).map_err(|e| e.to_string())?;
    Ok(hex::encode(sig))
}

#[derive(Debug, Serialize)]
pub struct DeviceAttestationResult {
    pub backend: String,
    pub public_key_hex: String,
    pub evidence_hex: String,
}

#[tauri::command]
pub async fn device_attest_key(label: String) -> Result<DeviceAttestationResult, String> {
    let key = tenzro_device_key::open(&label).map_err(|e| e.to_string())?;
    let att = key.attest().map_err(|e| e.to_string())?;
    Ok(DeviceAttestationResult {
        backend: att.backend.to_string(),
        public_key_hex: hex::encode(att.public_key),
        evidence_hex: hex::encode(att.evidence),
    })
}

#[tauri::command]
pub async fn device_delete_passkey(label: String) -> Result<(), String> {
    tenzro_device_key::delete(&label).map_err(|e| e.to_string())
}

/// Result of starting a FIDO caBLE cross-device ceremony — the frontend
/// renders the QR string and shows it to the user, then calls
/// `device_complete_cross_device_link` with the same `session_id` once
/// it has the WebAuthn challenge ready.
#[derive(Debug, Serialize)]
pub struct CableSessionStart {
    pub session_id: String,
    pub qr_url: String,
}

#[tauri::command]
pub async fn device_start_cross_device_link(
    cable: tauri::State<'_, std::sync::Arc<crate::cable::CableSessionManager>>,
) -> Result<CableSessionStart, String> {
    let (session_id, qr_url) = cable.start().await.map_err(|e| e.to_string())?;
    Ok(CableSessionStart { session_id, qr_url })
}

#[derive(Debug, Deserialize)]
pub struct CableCompleteRequest {
    pub session_id: String,
    pub challenge_hex: String,
    pub rp_id: String,
    #[serde(default)]
    pub allow_credential_ids_hex: Vec<String>,
}

#[tauri::command]
pub async fn device_complete_cross_device_link(
    cable: tauri::State<'_, std::sync::Arc<crate::cable::CableSessionManager>>,
    request: CableCompleteRequest,
) -> Result<crate::cable::CableAssertion, String> {
    let challenge = hex::decode(&request.challenge_hex)
        .map_err(|e| format!("challenge_hex: {}", e))?;

    let mut allow_credential_ids = Vec::with_capacity(request.allow_credential_ids_hex.len());
    for h in &request.allow_credential_ids_hex {
        let bytes = hex::decode(h).map_err(|e| format!("credential id: {}", e))?;
        allow_credential_ids.push(bytes);
    }

    cable
        .complete(
            &request.session_id,
            challenge,
            request.rp_id,
            allow_credential_ids,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_cancel_cross_device_link(
    cable: tauri::State<'_, std::sync::Arc<crate::cable::CableSessionManager>>,
    session_id: String,
) -> Result<(), String> {
    cable.cancel(&session_id).map_err(|e| e.to_string())
}

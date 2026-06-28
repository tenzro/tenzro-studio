//! Embedded node lifecycle — `#[tauri::command]` wrappers.
//!
//! The node-start / status / restart / reset / download-cancel logic
//! lives in `tenzro-studio-core::node_lifecycle` so the GUI and the
//! headless CLI run the same code. This module only wraps those
//! functions in Tauri command handlers (so the frontend's `invoke(...)`
//! still works) plus the GUI-only `request_role_change` wrapper, which
//! dispatches the node's `tenzro_setRole` RPC.
//!
//! `auto_start_node` is re-exported (not wrapped) because `lib.rs` calls
//! it directly from the setup hook, not via `invoke`.

pub use tenzro_studio_core::node_lifecycle::{NodeStatusView, auto_start_node};

use tauri::State;

use crate::AppState;

/// Live node status for the UI status bar. Returns `None` when the node
/// has not yet started (race window during app boot).
#[tauri::command]
pub async fn node_status(state: State<'_, AppState>) -> Result<Option<NodeStatusView>, String> {
    Ok(tenzro_studio_core::node_lifecycle::node_status(&state).await)
}

/// Switch the node's active runtime role. The "Serve AI" card flips to
/// `model_provider` and the "Validator" card to `validator`. Backed by
/// the node's `tenzro_setRole` RPC, which swaps the live `runtime_role`
/// and gossips the change on the status topic — no restart required.
///
/// `roles` is the full set the node should serve, since one node can serve
/// any combination under one stake. Accepts a comma-separated string
/// (`"validator,ai,storage"`) or the node's role names: `validator`,
/// `model_provider`/`ai`, `tee_provider`/`tee`, `storage`, `full_node`,
/// `light_client`. Returns the resolved role set on success.
#[tauri::command]
pub async fn request_role_change(
    roles: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let args = tenzro_studio_core::rpc_bridge::RpcCallArgs {
        method: "tenzro_setRole".to_string(),
        params: serde_json::json!({ "roles": roles }),
        admin_token: None,
        api_key: None,
    };
    let resp = tenzro_studio_core::rpc_bridge::rpc_call(args, &state).await?;

    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("role change failed");
        return Err(msg.to_string());
    }
    Ok(resp
        .get("result")
        .and_then(|r| r.get("roles"))
        .and_then(|r| r.as_str())
        .unwrap_or(&roles)
        .to_string())
}

/// Wipe local chain state and restart the node. Required after a
/// testnet rollback. See `tenzro_studio_core::node_lifecycle::reset_local_chain`.
#[tauri::command]
pub async fn reset_local_chain(state: State<'_, AppState>) -> Result<(), String> {
    tenzro_studio_core::node_lifecycle::reset_local_chain(&state).await
}

/// Force-restart the embedded node ("Retry connection" affordance). See
/// `tenzro_studio_core::node_lifecycle::restart_node`.
#[tauri::command]
pub async fn restart_node(state: State<'_, AppState>) -> Result<(), String> {
    tenzro_studio_core::node_lifecycle::restart_node(&state).await
}

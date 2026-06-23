//! Embedded node lifecycle — `#[tauri::command]` wrappers.
//!
//! The node-start / status / restart / reset / download-cancel logic
//! lives in `tenzro-studio-core::node_lifecycle` so the GUI and the
//! headless CLI run the same code. This module only wraps those
//! functions in Tauri command handlers (so the frontend's `invoke(...)`
//! still works) and keeps the GUI-only `request_role_change` stub.
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

/// Switch the node's active role. Used by the "Serve AI" card to flip
/// from ModelProvider-default to ModelProvider-with-serving (no role
/// change needed, just inference router advertisement) and by the
/// "Validator" card to upgrade to consensus participation.
///
/// Wave-1 implementation: only validates the request shape. Role
/// changes that require a node restart (Validator opt-in) need a
/// separate `restart_with_role` command that lands alongside the
/// staking flow. This stays GUI-side because the headless CLI exposes
/// the role choice through its own `serve --role` flag instead.
#[tauri::command]
pub async fn request_role_change(
    _role: String,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    // Wave-1 stub. The serving + validator flows in the UI cards
    // dispatch this command but the actual restart-with-new-role path
    // lands when the staking + provider-registration flows are wired
    // in their own commits.
    Err("Role change not yet implemented in this wave".to_string())
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

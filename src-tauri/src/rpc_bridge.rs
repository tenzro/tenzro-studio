//! In-process JSON-RPC bridge + llama-server sidecar bridge —
//! `#[tauri::command]` wrappers.
//!
//! All the logic (node RPC dispatch, sidecar chat with the
//! model-not-found restart+retry, load/unload, model-details, offload,
//! local-model listing, hardware probe) lives in
//! `tenzro-studio-core::rpc_bridge` so the GUI and the headless CLI share
//! one implementation. These wrappers only add the Tauri glue:
//! `State<'_, AppState>` extraction and — critically — the UI-heartbeat
//! pause on the two commands that can block on a multi-GB model load.

use serde_json::Value;
use tauri::State;

use crate::AppState;

pub use tenzro_studio_core::rpc_bridge::{
    RpcCallArgs, ServingOverridesArgs, SidecarChatArgs, SidecarLoadArgs, SidecarUnloadArgs,
};

#[tauri::command]
pub async fn rpc_call(args: RpcCallArgs, state: State<'_, AppState>) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::rpc_call(args, &state).await
}

/// Proxy a chat-completion request to the sidecar. Holds the UI-heartbeat
/// pause for the whole request: the router transparently loads the target
/// model on the first chat referencing it, so this path can block on a
/// multi-GB load. Without the pause that stall trips the watchdog's
/// 15s heartbeat timeout and kills the app mid-load. The headless CLI
/// doesn't need this — there's no renderer heartbeat to starve — so the
/// guard lives here, not in core.
#[tauri::command]
pub async fn sidecar_chat(
    hb: State<'_, std::sync::Arc<crate::watchdog::UiHeartbeat>>,
    args: SidecarChatArgs,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _pause = hb.pause();
    tenzro_studio_core::rpc_bridge::sidecar_chat(args, &state).await
}

/// Explicit load via the router's `POST /models/load`. Same heartbeat
/// pause rationale as [`sidecar_chat`] — loading a multi-GB GGUF
/// saturates CPU/GPU long enough that WebKit throttles the renderer's
/// `requestAnimationFrame` heartbeat, and the watchdog would otherwise
/// read the stalled ping as a dead WebView and kill the app mid-load.
#[tauri::command]
pub async fn sidecar_load_model(
    hb: State<'_, std::sync::Arc<crate::watchdog::UiHeartbeat>>,
    args: SidecarLoadArgs,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let _pause = hb.pause();
    tenzro_studio_core::rpc_bridge::sidecar_load_model(args, &state).await
}

#[tauri::command]
pub async fn sidecar_unload_model(
    args: SidecarUnloadArgs,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::sidecar_unload_model(args, &state).await
}

#[tauri::command]
pub async fn sidecar_list_models(state: State<'_, AppState>) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::sidecar_list_models(&state).await
}

#[tauri::command]
pub async fn sidecar_refresh_models(state: State<'_, AppState>) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::sidecar_refresh_models(&state).await
}

#[tauri::command]
pub async fn set_serving_overrides(
    state: State<'_, AppState>,
    args: ServingOverridesArgs,
) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::set_serving_overrides(args, &state).await
}

#[tauri::command]
pub async fn sidecar_status(state: State<'_, AppState>) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::sidecar_status(&state).await
}

#[tauri::command]
pub fn hardware_profile() -> Value {
    tenzro_studio_core::rpc_bridge::hardware_profile()
}

/// What this machine can offer on the network (serve AI, rent out compute,
/// host storage) plus the headroom behind each. The UI shows this before a
/// user opts into providing.
#[tauri::command]
pub fn capability_readout() -> Value {
    tenzro_studio_core::rpc_bridge::capability_readout()
}

#[tauri::command]
pub async fn model_details(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::model_details(id, &state).await
}

#[tauri::command]
pub async fn offload_model(id: String, state: State<'_, AppState>) -> Result<u64, String> {
    tenzro_studio_core::rpc_bridge::offload_model(id, &state).await
}

#[tauri::command]
pub async fn local_models() -> Result<Value, String> {
    tenzro_studio_core::rpc_bridge::local_models().await
}

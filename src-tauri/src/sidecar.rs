//! llama-server sidecar process management — GUI shim.
//!
//! The whole implementation (spawn, health-wait, preset generation,
//! self-contained-binary resolution, SIGTERM→SIGKILL stop) lives in
//! `tenzro-studio-core::sidecar` so the headless CLI and this GUI app
//! manage the sidecar identically. Core's `spawn_sidecar` /
//! `restart_sidecar` don't take an `AppHandle` (the runtime resolves the
//! sidecar path from `std::env::current_exe()`, never from the handle),
//! so these thin wrappers exist only to keep the app's old
//! `AppHandle`-taking call sites compiling while dropping the unused
//! argument before delegating to core.

pub use tenzro_studio_core::sidecar::SidecarHandle;

use std::sync::Arc;

use tauri::AppHandle;

/// Spawn the llama-server sidecar. The `_app` handle is ignored — core
/// resolves the bundled sidecar binary from the current exe's directory,
/// not from Tauri's resource resolver. Kept in the signature so the
/// setup hook in `lib.rs` doesn't need to change shape.
///
/// `restart_sidecar` is NOT re-wrapped here: the only callers (the
/// chat / refresh / serving-override command handlers) delegate straight
/// to `tenzro_studio_core::rpc_bridge`, which calls
/// `tenzro_studio_core::sidecar::restart_sidecar` internally — so the GUI
/// process never needs its own restart wrapper.
pub async fn spawn_sidecar(_app: &AppHandle) -> Result<Arc<SidecarHandle>, String> {
    tenzro_studio_core::sidecar::spawn_sidecar().await
}

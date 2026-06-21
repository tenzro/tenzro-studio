//! Embedded node lifecycle — auto-starts on app launch, dials the
//! testnet bootstrap peers, surfaces status to the UI.
//!
//! Design: the node is an always-on background service. Users never
//! click "Start Node" — connectivity to the Tenzro Network is part of
//! the app's identity. The UI cards (Use Network / Run Local / Serve /
//! Validate) configure what the node DOES, not whether it's running.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tracing::{info, warn};

use crate::AppState;

/// Live status surfaced to the UI. Subset of [`tenzro_node::NodeStatus`]
/// with the fields the cards + status bar actually render.
#[derive(Debug, Clone, Serialize)]
pub struct NodeStatusView {
    pub state: String,
    pub role: String,
    pub block_height: u64,
    pub peer_count: u64,
    pub uptime_secs: u64,
    pub tee_capable: bool,
    pub iroh_enabled: bool,
    /// Coarse-grained connectivity hint for the status bar:
    /// `"connecting"` when the node is up but has no peers yet,
    /// `"syncing"` when peers are present but `block_height == 0`,
    /// `"connected"` when both peers and a non-zero height are visible.
    pub connectivity: String,
}

impl From<&tenzro_node::NodeStatus> for NodeStatusView {
    fn from(s: &tenzro_node::NodeStatus) -> Self {
        let connectivity = match (s.peer_count, s.block_height) {
            (0, _) => "connecting",
            (_, 0) => "syncing",
            _ => "connected",
        }
        .to_string();
        Self {
            state: s.state.clone(),
            role: format!("{:?}", s.role),
            block_height: s.block_height,
            peer_count: s.peer_count,
            uptime_secs: s.uptime_secs,
            tee_capable: s.tee_capable,
            iroh_enabled: s.iroh_enabled,
            connectivity,
        }
    }
}

/// Clear leftover state that would block a fresh node start after an
/// abnormal exit (Metal teardown abort, SIGKILL, OOM, force-quit):
///
/// - RocksDB `LOCK` file in `~/.tenzro/inference/db/` — RocksDB
///   refuses to open the DB while this is present, so a process
///   killed mid-write leaves the next boot stuck waiting.
/// - Partial `.tmp` / `.partial` GGUF files in `~/.tenzro/models/`.
fn clear_stale_state_on_boot() {
    let Some(home) = dirs::home_dir() else {
        return;
    };

    // RocksDB LOCK — only safe to unlink because we know our own
    // process is the sole writer (single-user desktop app). Server
    // / multi-tenant scenarios would need a PID check, but for the
    // app there is by construction no other process holding the DB.
    let lock = home.join(".tenzro/inference/db/LOCK");
    if lock.exists() {
        tracing::info!("Clearing stale RocksDB LOCK from previous abnormal exit: {}", lock.display());
        let _ = std::fs::remove_file(&lock);
    }

    clear_partial_downloads();
}

/// Scan `~/.tenzro/models/` for orphaned partial downloads (`.tmp` /
/// `.partial` / `.download` files) and unlink them.
fn clear_partial_downloads() {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join(".tenzro/models");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.ends_with(".tmp")
            || name.ends_with(".partial")
            || name.ends_with(".download")
            || name.contains(".gguf.tmp")
        {
            tracing::info!("Clearing orphaned partial download: {}", path.display());
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Spawn the embedded node in the background. Called once from
/// `lib.rs::setup` so the UI never has to ask. Idempotent: a second
/// call is a no-op.
pub async fn auto_start_node(state: &AppState) -> Result<(), String> {
    // Boot-time cleanup: prior abnormal exits (Metal teardown abort,
    // window force-close, OOM-kill, etc.) leave behind RocksDB LOCK
    // files and partial GGUF downloads that would block the next
    // start. Sweep before the node tries to open the DB.
    clear_stale_state_on_boot();

    {
        let guard = state.node.read().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let mut config = tenzro_node::NodeConfig::default();

    // Default role: ModelProvider. The node joins the network, syncs
    // blocks, and is ready to advertise served models when the user
    // picks the "Serve AI" card. Validator role is opt-in via the
    // dedicated card flow.
    config.role = tenzro_types::network::NetworkRole::ModelProvider;

    // Anchor every subsystem under ~/.tenzro/inference (not the .app
    // bundle's read-only cwd).
    let home = dirs::home_dir()
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    config.data_dir = home.join(".tenzro").join("inference");
    std::fs::create_dir_all(&config.data_dir)
        .map_err(|e| format!("could not create data dir: {}", e))?;

    // Bootstrap peers — auto-connect to the live Tenzro testnet. The
    // first DNS name resolves to validator-0 (the public RPC + boot
    // node); the rest of the fleet is discovered via libp2p Kademlia
    // once the first hop is established.
    config.network.boot_nodes = vec![
        "/dns4/testnet-boot-1.tenzro.network/tcp/9000"
            .parse()
            .expect("static testnet bootstrap multiaddr is valid"),
        "/dns4/testnet-boot-2.tenzro.network/tcp/9000"
            .parse()
            .expect("static testnet bootstrap multiaddr is valid"),
    ];

    info!(
        "Auto-starting embedded node: role={:?}, data_dir={}, boot_nodes={}",
        config.role,
        config.data_dir.display(),
        config.network.boot_nodes.len()
    );

    let handle = tenzro_node::spawn_in_background(config)
        .await
        .map_err(|e| {
            warn!("Embedded node failed to start: {}", e);
            format!("failed to start node: {}", e)
        })?;

    {
        let mut guard = state.node.write().await;
        *guard = Some(Arc::new(handle));
    }

    info!("Embedded node started and dialing testnet bootstrap peers");
    Ok(())
}

/// Live node status for the UI status bar. Returns `None` when the node
/// has not yet started (race window during app boot).
#[tauri::command]
pub async fn node_status(state: State<'_, AppState>) -> Result<Option<NodeStatusView>, String> {
    let guard = state.node.read().await;
    Ok(guard.as_ref().map(|h| NodeStatusView::from(&h.current_status())))
}

/// Unload every model from the embedded llama.cpp runtime before
/// Cancel every in-flight model download. Called from the app's window
/// close handler so partial GGUF files don't accumulate in
/// `~/.tenzro/models/` when the user quits during a download.
pub async fn cancel_all_downloads(state: &AppState) {
    let guard = state.node.read().await;
    let Some(handle) = guard.as_ref() else {
        return;
    };
    let node = handle.node();
    // Snapshot model_ids of in-flight downloads. We can't call the
    // public `tenzro_cancelDownload` RPC here (no auth context) so we
    // mutate the per-model DashMap entry directly and unlink the
    // partial file the same way the RPC handler does.
    let in_flight: Vec<String> = node
        .model_downloads
        .iter()
        .filter(|kv| {
            matches!(kv.value().status.as_str(), "downloading" | "in_progress" | "not_started")
        })
        .map(|kv| kv.key().clone())
        .collect();

    for model_id in in_flight {
        if let Some(mut entry) = node.model_downloads.get_mut(&model_id) {
            entry.status = "cancelled".to_string();
            entry.error = Some("cancelled on app shutdown".to_string());
        }
        if let Some(home) = dirs::home_dir() {
            for path in [
                home.join(".tenzro/models").join(format!("{}.gguf", &model_id)),
                home.join(".tenzro/models").join(&model_id),
            ] {
                if path.exists() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        tracing::info!("Cancelled in-flight download on shutdown: {}", model_id);
    }
}

/// Switch the node's active role. Used by the "Serve AI" card to flip
/// from ModelProvider-default to ModelProvider-with-serving (no role
/// change needed, just inference router advertisement) and by the
/// "Validator" card to upgrade to consensus participation.
///
/// Wave-1 implementation: only validates the request shape. Role
/// changes that require a node restart (Validator opt-in) need a
/// separate `restart_with_role` command that lands alongside the
/// staking flow.
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

/// Force-restart the embedded node. The UI surfaces this as a "Retry
/// connection" affordance when the status bar has been "connecting" too
/// long (typically because the previous run died mid-dial and left
/// stale libp2p state, or the testnet boot peers were briefly
/// unreachable). Performs a graceful shutdown of the current handle
/// (if any), then auto-starts a fresh one.
#[tauri::command]
pub async fn restart_node(state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("Manual node restart requested");

    // Tear down the current handle if there is one. Take it out of
    // AppState first so a concurrent status_poll doesn't see a
    // half-shut-down node.
    let prev = {
        let mut guard = state.node.write().await;
        guard.take()
    };
    if let Some(handle) = prev {
        unload_all_models_inner(&handle).await;
        if let Err(e) = handle.shutdown_and_wait().await {
            tracing::warn!("Previous node shutdown error on restart: {}", e);
        }
    }

    // Re-sweep stale state (LOCK file, partial GGUFs) before the
    // fresh node tries to open RocksDB.
    clear_stale_state_on_boot();

    // Spawn fresh.
    auto_start_node(&state).await
}

/// Internal: unload all models for a given handle, factored out of
/// `unload_all_models` so the restart path can reuse it on a handle
/// we already took out of AppState.
async fn unload_all_models_inner(handle: &tenzro_node::NodeHandle) {
    let Some(runtime) = handle.node().model_runtime_arc() else {
        return;
    };
    let loaded = runtime.list_loaded();
    for model_id in loaded {
        tracing::info!("Unloading model on restart: {}", model_id);
        if let Err(e) = runtime.unload_model(&model_id).await {
            tracing::warn!("unload_model({}) failed on restart: {}", model_id, e);
        }
    }
}

//! Ipnops Edge — Tauri backend.
//!
//! On launch, the embedded Tenzro node spawns in the background and
//! auto-dials the testnet bootstrap peers. The llama.cpp inference
//! engine runs as an out-of-process `llama-server` sidecar so a Metal
//! teardown abort, CUDA OOM, or any llama.cpp panic cannot kill the UI.
//! The UI never asks the user to "Start Node" — connectivity is
//! always-on; the 4 cards in the main screen just choose what the
//! node DOES.

mod hardware;
mod node_lifecycle;
mod rpc_bridge;
mod sidecar;
mod streaming;

use std::collections::HashMap;
use std::sync::Arc;

use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

/// Tauri-managed state: the running node handle, the llama-server
/// sidecar handle, and the in-flight chat-stream cancellation map.
pub struct AppState {
    pub node: RwLock<Option<Arc<tenzro_node::NodeHandle>>>,
    pub sidecar: RwLock<Option<Arc<sidecar::SidecarHandle>>>,
    /// `request_id` → `CancellationToken` for every chat stream
    /// currently driving the sidecar. The streaming module uses this
    /// for both registration (on chat start) and cancellation (on
    /// user stop).
    pub inflight: streaming::InflightMap,
}

impl AppState {
    fn new() -> Self {
        Self {
            node: RwLock::new(None),
            sidecar: RwLock::new(None),
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // SQL migrations for the local conversation store. Lives at
    // ~/.tenzro/inference/conversations.db. Versioned + idempotent
    // so future schema changes apply on app start.
    let migrations = vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "create conversations + messages tables",
            sql: r#"
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    stats_json TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
            "#,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ];

    let app = tauri::Builder::default()
        // Single-instance MUST be registered first so a double-launch
        // focuses the existing window and routes deep-link args via
        // the callback instead of spawning a second node fighting
        // for the RocksDB lock.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Restore the window's size + position from the previous
        // session.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:conversations.db", migrations)
                .build(),
        )
        // Auto-updater. Hosts a signed `latest.json` at
        // tenzro.com/inference/updates/{target}/{arch}/{current_version}
        // when configured via tauri.conf.json. Until then the plugin
        // is registered but no endpoints are set — the JS side will
        // skip the check silently.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Global shortcut registration for the future quick-chat
        // hotkey (Cmd-Shift-Space → floating window, Raycast
        // pattern). The plugin is registered here; the per-shortcut
        // binding + tray-icon wiring lands in the menu bar surface.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            node_lifecycle::node_status,
            node_lifecycle::request_role_change,
            node_lifecycle::restart_node,
            rpc_bridge::rpc_call,
            rpc_bridge::sidecar_chat,
            rpc_bridge::sidecar_load_model,
            rpc_bridge::sidecar_unload_model,
            rpc_bridge::sidecar_list_models,
            rpc_bridge::sidecar_refresh_models,
            rpc_bridge::sidecar_status,
            streaming::sidecar_chat_stream,
            streaming::sidecar_chat_cancel,
        ])
        .setup(|app| {
            // Spawn the llama-server sidecar in parallel with the
            // node bootstrap. Sidecar process isolation means a Metal
            // teardown crash never propagates to the UI — the
            // headline SOTA stability win.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                // Double-spawn guard: never start a second sidecar if
                // one is already registered. Two routers serving the
                // same models-dir contend for Metal residency and wedge
                // inference.
                if state.sidecar.read().await.is_some() {
                    tracing::warn!("Sidecar already running — skipping duplicate spawn");
                    return;
                }
                match sidecar::spawn_sidecar(&handle).await {
                    Ok(sidecar_handle) => {
                        let mut guard = state.sidecar.write().await;
                        if guard.is_some() {
                            // Lost a spawn race — stop the one we just
                            // started so we don't leak a second router.
                            tracing::warn!("Sidecar spawn raced — stopping the redundant instance");
                            drop(guard);
                            sidecar_handle.stop().await;
                        } else {
                            *guard = Some(sidecar_handle);
                            tracing::info!("llama-server sidecar ready");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Sidecar spawn failed: {}", e);
                    }
                }
            });

            // Auto-start the embedded node.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if let Err(e) = node_lifecycle::auto_start_node(&state).await {
                    tracing::error!("Node auto-start failed: {}", e);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ipnops-edge");

    // Both `RunEvent::ExitRequested` (Cmd-Q / Quit menu / AppKit
    // termination) and `WindowEvent::CloseRequested` (window X /
    // Cmd-W) call the same idempotent `graceful_shutdown` so the
    // sidecar is always killed regardless of how the user exits.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api: _, code: _, .. } => {
            tracing::info!("App exit requested — running graceful teardown");
            let app_handle = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                let state = app_handle.state::<AppState>();
                graceful_shutdown(&state).await;
            });
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => {
            tracing::info!("Window close requested — running graceful teardown");
            let app_handle = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                let state = app_handle.state::<AppState>();
                graceful_shutdown(&state).await;
            });
        }
        _ => {}
    });
}

/// Ordered teardown. With the sidecar pattern the Metal teardown
/// danger is entirely inside the sidecar process — killing the
/// sidecar with SIGKILL is the only reliable way to release Metal /
/// CUDA buffers on macOS / Linux drivers, and is far safer than the
/// in-process model unload dance the previous build attempted.
///
/// 1. Stop the llama-server sidecar (SIGTERM, then SIGKILL after 3s).
/// 2. Cancel in-flight downloads on the node side (cleans up .tmp
///    files).
/// 3. Drain the embedded node so RocksDB flushes + libp2p disconnects
///    run cleanly.
///
/// Idempotent — safe to call multiple times.
async fn graceful_shutdown(state: &AppState) {
    // Sidecar first so its Metal residency sets are reclaimed before
    // the node shutdown holds the runtime for several seconds.
    let sidecar = {
        let mut guard = state.sidecar.write().await;
        guard.take()
    };
    if let Some(sidecar) = sidecar {
        sidecar.stop().await;
    }

    node_lifecycle::cancel_all_downloads(state).await;
    let node = {
        let mut guard = state.node.write().await;
        guard.take()
    };
    if let Some(handle) = node {
        if let Err(e) = handle.shutdown_and_wait().await {
            tracing::warn!("Node shutdown error: {}", e);
        }
    }
}

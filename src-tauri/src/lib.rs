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
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

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

/// Logging sink + appender guard. The non-blocking appender's worker
/// thread shuts down + flushes when [`tracing_appender::non_blocking::WorkerGuard`]
/// is dropped, so the run() must keep this alive for the whole app
/// lifetime.
struct LogGuard {
    writer: tracing_appender::non_blocking::NonBlocking,
    _guard: tracing_appender::non_blocking::WorkerGuard,
}

/// Initialise the file appender under `~/.tenzro/inference/logs/edge.log`
/// (daily-rotated). Returns `None` if the home directory or logs dir
/// can't be created — in that case we fall back to stderr-only.
fn init_logging() -> Option<LogGuard> {
    let home = dirs::home_dir()?;
    let log_dir = home.join(".tenzro").join("inference").join("logs");
    std::fs::create_dir_all(&log_dir).ok()?;
    let file_appender = tracing_appender::rolling::daily(&log_dir, "edge.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    Some(LogGuard {
        writer,
        _guard: guard,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dual sink: stderr (for `tauri dev` + `Console.app` capture) AND
    // a daily-rotated file under ~/.tenzro/inference/logs/edge.log so
    // user crash reports include the full run-up to a failure. The
    // file is non-blocking (a background writer thread) — the
    // returned guard MUST stay alive for the lifetime of the app
    // (dropping it flushes + ends the writer).
    let log_guard = init_logging();

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    let registry = tracing_subscriber::registry().with(env_filter).with(stderr_layer);
    if let Some(file_writer) = log_guard.as_ref().map(|g| g.writer.clone()) {
        let file_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(file_writer);
        registry.with(file_layer).init();
    } else {
        registry.init();
    }
    // Keep the guard alive for the lifetime of the process; dropping
    // it would close the appender background thread mid-app.
    if let Some(g) = log_guard {
        Box::leak(Box::new(g));
    }

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
            node_lifecycle::reset_local_chain,
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

            // Unix signal handler — RunEvent::ExitRequested only fires for UI
            // quits (Cmd-Q, window close). A SIGTERM/SIGINT/SIGHUP from
            // outside (terminal kill, parent process death, system shutdown,
            // crash recovery) would otherwise bypass graceful_shutdown and
            // orphan the llama-server sidecar — see the orphaned-sidecar
            // bug. Listen for those signals and call exit(), which then
            // routes through the normal ExitRequested path.
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{SignalKind, signal};
                    let mut sigterm = match signal(SignalKind::terminate()) {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("SIGTERM listener install failed: {}", e);
                            return;
                        }
                    };
                    let mut sigint = match signal(SignalKind::interrupt()) {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("SIGINT listener install failed: {}", e);
                            return;
                        }
                    };
                    let mut sighup = match signal(SignalKind::hangup()) {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("SIGHUP listener install failed: {}", e);
                            return;
                        }
                    };
                    let sig = tokio::select! {
                        _ = sigterm.recv() => "SIGTERM",
                        _ = sigint.recv() => "SIGINT",
                        _ = sighup.recv() => "SIGHUP",
                    };
                    tracing::info!("Received {} — requesting app exit", sig);
                    handle.exit(0);
                });
            }

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

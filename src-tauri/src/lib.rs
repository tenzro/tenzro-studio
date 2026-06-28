//! Tenzro Studio — Tauri backend.
//!
//! On launch, the embedded Tenzro node spawns in the background and
//! auto-dials the testnet bootstrap peers. The llama.cpp inference
//! engine runs as an out-of-process `llama-server` sidecar so a Metal
//! teardown abort, CUDA OOM, or any llama.cpp panic cannot kill the UI.
//! The UI never asks the user to "Start Node" — connectivity is
//! always-on; the 4 cards in the main screen just choose what the
//! node DOES.

mod cable;
mod crash_safety;
mod device_commands;
mod node_lifecycle;
mod rpc_bridge;
mod sidecar;
mod streaming;
mod telemetry;
mod wallet;
mod watchdog;

use tauri::{Emitter, Manager};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

// The shared application state (node handle + sidecar handle + in-flight
// stream cancellation map) and the ordered teardown both live in
// `tenzro-studio-core` so the GUI app and the headless CLI run identical
// lifecycle logic. The Tauri layer just `.manage()`s core's `AppState`
// and routes its exit hooks through core's `graceful_shutdown`.
pub use tenzro_studio_core::{AppState, graceful_shutdown};

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
    // Crash-safety net FIRST, before anything else can panic. Installs
    // the panic hook, libc::atexit handler, and alloc-error hook. Three
    // layers because Tauri 2 + macOS has multiple silent-exit paths
    // (wry non-unwinding panic, tokio spawn-task panic dropped on the
    // floor, double-Drop panic) and any one of them leaves the
    // llama-server sidecar orphaned with ppid=1. See src/crash_safety.rs
    // for the full failure-mode catalogue + citations.
    crash_safety::install_safety_net();

    // Install aws-lc-rs as the process-wide rustls CryptoProvider before the
    // embedded node builds its libp2p TLS transport. The node authenticates
    // peer connections with libp2p-tls using the PQ-hybrid X25519MLKEM768 group,
    // which only aws-lc-rs ships. `tenzro-node::main` does this install, but
    // Studio spawns the node via `spawn_in_background_with_unlocker` and never
    // runs that main — so without this every bootstrap-peer handshake fails at
    // the TLS upgrade ("Failed to upgrade client connection") and the node sits
    // at 0 peers. `Err` just means another static init already installed the
    // same provider; that's harmless, so we don't fail startup on it.
    if rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .is_err()
    {
        // Already installed by an earlier static init — fine, continue.
    }

    // Opt-in crash telemetry. Initialised ONLY when (a) a DSN was
    // baked into the build via TENZRO_STUDIO_SENTRY_DSN at compile time AND
    // (b) the user has explicitly opted in by creating the sentinel
    // file ~/.tenzro/inference/telemetry.enabled. A fresh install
    // sends nothing without explicit user consent. The returned
    // ClientInitGuard MUST outlive the app — drop = flush + shutdown.
    let sentry_guard = telemetry::init();

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
    // Sentry breadcrumbs from tracing — only active when sentry is
    // initialised (no DSN or no opt-in = the layer is still wired but
    // sentry::capture_* are no-ops).
    let sentry_layer = sentry_tracing::layer();

    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(sentry_layer);
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
    // Same lifetime story for the sentry guard. ClientInitGuard's Drop
    // flushes + shuts down the transport — we want that to happen on
    // process exit, not on run()'s frame teardown (which is right after
    // `app.run` returns, an instant before the process exits anyway,
    // but leaking is the canonical pattern).
    if let Some(g) = sentry_guard {
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
        tauri_plugin_sql::Migration {
            version: 2,
            description: "add projects (folders) for conversations; nullable project_id on conversations",
            // Projects = Claude-style per-project knowledge container.
            // A conversation belongs to AT MOST ONE project (NULL =
            // "unfiled"). Cascading DELETE on the project removes its
            // conversations too — that's the explicit user expectation
            // ("delete this project and everything in it").
            sql: r#"
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    color TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
                CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at DESC);
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
        // Native OS dialogs (file picker, confirm, message). Replaces
        // every window.confirm/alert — those are WebView-blocked in
        // some configs and have inconsistent cross-platform UX.
        .plugin(tauri_plugin_dialog::init())
        // Non-secret preference store (theme, default model, chat
        // retention, telemetry opt-in). Written to a JSON file under
        // the app's data dir, auto-saved on change.
        .plugin(tauri_plugin_store::Builder::new().build())
        // Deep-link scheme `tenzro-studio://` so join-validator
        // referral links, share-model links, etc. open the app and
        // route to the right view (handled in setup() below).
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::new())
        .manage(watchdog::UiHeartbeat::new())
        // FIDO caBLE session manager — drives the cross-device passkey
        // ceremony (QR + Bluetooth tunnel) so the user's phone-resident
        // passkey can sign for the desktop without ever transferring
        // the private key. State is shared so `device_start` and
        // `device_complete` see the same session map.
        .manage(std::sync::Arc::new(cable::CableSessionManager::new()))
        .invoke_handler(tauri::generate_handler![
            node_lifecycle::node_status,
            node_lifecycle::request_role_change,
            node_lifecycle::restart_node,
            node_lifecycle::reset_local_chain,
            telemetry::telemetry_state,
            telemetry::set_telemetry_enabled,
            watchdog::ui_alive,
            watchdog::ui_visibility,
            wallet::wallet_status,
            wallet::wallet_create,
            rpc_bridge::model_details,
            rpc_bridge::local_models,
            rpc_bridge::offload_model,
            rpc_bridge::hardware_profile,
            rpc_bridge::capability_readout,
            rpc_bridge::rpc_call,
            rpc_bridge::sidecar_chat,
            rpc_bridge::sidecar_load_model,
            rpc_bridge::sidecar_unload_model,
            rpc_bridge::sidecar_list_models,
            rpc_bridge::sidecar_refresh_models,
            rpc_bridge::set_serving_overrides,
            rpc_bridge::sidecar_status,
            streaming::sidecar_chat_stream,
            streaming::sidecar_chat_cancel,
            // Device-side passkey primitives — wallet RPCs themselves
            // are operator-hosted on rpc.tenzro.network; these only own
            // the parts that MUST live in the Tauri process (secure
            // enclave access + FIDO caBLE Bluetooth ceremony).
            device_commands::device_create_passkey,
            device_commands::device_sign_with_passkey,
            device_commands::device_sign_hybrid_with_passkey,
            device_commands::device_start_cross_device_link,
            device_commands::device_complete_cross_device_link,
            device_commands::device_cancel_cross_device_link,
        ])
        .setup(|app| {
            // Native menu bar — predefined items get correct platform
            // accelerators automatically (Cmd-Q, Cmd-M, Cmd-W, Cmd-Z,
            // Cmd-X, Cmd-C, Cmd-V, etc). Custom items dispatch via the
            // on_menu_event hook; the frontend listens for menu events
            // and routes them (e.g. "settings" -> open Settings modal).
            use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
            let about = AboutMetadataBuilder::new()
                .name(Some("Tenzro Studio"))
                .version(Some("0.1.0"))
                .copyright(Some("Copyright 2026 Tenzro Labs"))
                .license(Some("Apache 2.0"))
                .website(Some("https://tenzro.com"))
                .build();
            let settings_item = MenuItemBuilder::new("Settings…")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let new_chat_item = MenuItemBuilder::new("New Chat")
                .id("new_chat")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let palette_item = MenuItemBuilder::new("Command Palette…")
                .id("palette")
                .accelerator("CmdOrCtrl+K")
                .build(app)?;
            let wallet_item = MenuItemBuilder::new("Wallet")
                .id("wallet")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Tenzro Studio")
                .item(&PredefinedMenuItem::about(app, Some("About Tenzro Studio"), Some(about))?)
                .separator()
                .item(&settings_item)
                .separator()
                .item(&PredefinedMenuItem::services(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_chat_item)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&palette_item)
                .item(&wallet_item)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;
            app.set_menu(menu)?;
            // Custom-id menu events go to the frontend via the
            // `menu-event` Tauri event so any open page can react.
            let menu_handle = app.handle().clone();
            app.on_menu_event(move |_app, ev| {
                let _ = menu_handle.emit_to(tauri::EventTarget::any(), "menu-event", ev.id().0.clone());
            });

            // Spawn the llama-server sidecar in parallel with the
            // node bootstrap. Sidecar process isolation means a Metal
            // teardown crash never propagates to the UI — the headline
            // stability win.
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

            // UI heartbeat watchdog. Tauri 2.11 does not expose wry's
            // `with_on_web_content_process_terminate_handler`, so the
            // only reliable signal that WKWebView died (renderer crash,
            // jetsam, JS-thread deadlock) is a JS-side ping that stops
            // arriving. Frontend posts `invoke('ui_alive')` every ~2s
            // from a requestAnimationFrame loop; we declare the WebView
            // dead after 15s of silence and trigger graceful shutdown.
            // See src/watchdog.rs.
            let hb = app.state::<std::sync::Arc<watchdog::UiHeartbeat>>().inner().clone();
            watchdog::spawn_watchdog(app.handle(), hb);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tenzro-studio");

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

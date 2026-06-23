//! UI heartbeat watchdog — detects WKWebView freeze / WebContent jetsam.
//!
//! Tauri 2.11 does NOT expose wry's
//! `with_on_web_content_process_terminate_handler` hook, so there is no
//! way to detect a renderer crash from the Rust side directly. Only
//! reliable signal: a JS-side ping driven by `requestAnimationFrame`
//! (which stops firing if the renderer is wedged or jetsamed — unlike
//! `setInterval`, which keeps queuing callbacks even when the JS main
//! thread is blocked, and would mask a true freeze).
//!
//! Flow:
//! 1. Frontend calls `invoke('ui_alive')` every ~2s from a `requestAnimationFrame`
//!    loop in `src/main.tsx`.
//! 2. This module's `ui_alive` Tauri command bumps an `AtomicU64`
//!    holding the last-seen timestamp.
//! 3. `spawn_watchdog` polls every 3s; if age > 15s, logs an error
//!    and calls `app_handle.exit(0)`. That fires `RunEvent::ExitRequested`
//!    → existing graceful_shutdown reaps the sidecar cleanly.
//!
//! See: <https://github.com/tauri-apps/wry/blob/dev/src/lib.rs>
//! (`with_on_web_content_process_terminate_handler`), and
//! <https://github.com/tauri-apps/tauri/issues/13498>.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, State};

/// Threshold for declaring the WebView dead. With a 2s JS ping cadence
/// + 3s Rust poll cadence, 15s ≈ 7 missed pings — well past any GC
/// pause or main-thread blip, short enough that a real freeze doesn't
/// keep an orphaned sidecar resident on the GPU for long.
const HEARTBEAT_TIMEOUT_MS: u64 = 15_000;

/// Time between watchdog polls. Cheap (just an atomic load), so 3s is
/// fine. Don't go below ~1s; the JS RAF loop also takes a moment to
/// recover after a GC pause.
const POLL_INTERVAL_SECS: u64 = 3;

pub struct UiHeartbeat {
    last_seen_ms: AtomicU64,
    /// Nesting depth of active "pause" requests. While > 0 the watchdog
    /// treats the UI as alive regardless of ping age. A native Touch ID /
    /// Secure Enclave prompt blocks the WebView's main thread (and thus the
    /// `requestAnimationFrame` ping loop) for as long as the user takes to
    /// authenticate, which can easily exceed the 15s timeout and trip a
    /// false-positive shutdown mid-prompt. Device-key commands bracket their
    /// work in a [`HeartbeatPause`] so the watchdog stands down for the
    /// duration. A counter (not a bool) so concurrent/nested prompts compose.
    pause_depth: AtomicUsize,
}

impl UiHeartbeat {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            last_seen_ms: AtomicU64::new(now_ms()),
            pause_depth: AtomicUsize::new(0),
        })
    }

    fn bump(&self) {
        self.last_seen_ms.store(now_ms(), Ordering::Relaxed);
    }

    fn age_ms(&self) -> u64 {
        now_ms().saturating_sub(self.last_seen_ms.load(Ordering::Relaxed))
    }

    fn is_paused(&self) -> bool {
        self.pause_depth.load(Ordering::Relaxed) > 0
    }

    /// Suspend the heartbeat-timeout check until the returned guard drops.
    /// Use around any operation that legitimately blocks the WebView thread
    /// (e.g. a native biometric prompt). On drop the heartbeat is bumped so
    /// the watchdog doesn't immediately fire on stale age accumulated while
    /// the UI thread was blocked.
    pub fn pause(self: &Arc<Self>) -> HeartbeatPause {
        self.pause_depth.fetch_add(1, Ordering::Relaxed);
        HeartbeatPause { hb: self.clone() }
    }
}

/// RAII guard returned by [`UiHeartbeat::pause`]. Decrements the pause depth
/// and refreshes the heartbeat when dropped.
pub struct HeartbeatPause {
    hb: Arc<UiHeartbeat>,
}

impl Drop for HeartbeatPause {
    fn drop(&mut self) {
        // Refresh first so the watchdog's next poll sees a fresh timestamp
        // rather than the (now stale) one from before the blocking op.
        self.hb.bump();
        self.hb.pause_depth.fetch_sub(1, Ordering::Relaxed);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Tauri command — frontend calls this every ~2s via
/// `invoke('ui_alive')` from a `requestAnimationFrame` loop.
#[tauri::command]
pub fn ui_alive(hb: State<'_, Arc<UiHeartbeat>>) {
    hb.bump();
}

/// Spawn the polling watchdog. Bumps the heartbeat immediately so the
/// first ~3s of UI startup (before React has mounted) doesn't trigger
/// a false positive.
pub fn spawn_watchdog(app: &AppHandle, hb: Arc<UiHeartbeat>) {
    let app = app.clone();
    hb.bump();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
        tick.tick().await; // skip the immediate first tick
        loop {
            tick.tick().await;
            // A native biometric prompt blocks the WebView thread, stalling
            // the UI ping loop. While a device-key op holds a pause guard,
            // keep the heartbeat fresh and skip the timeout check so we don't
            // kill the app mid-Touch-ID.
            if hb.is_paused() {
                hb.bump();
                continue;
            }
            let age = hb.age_ms();
            if age > HEARTBEAT_TIMEOUT_MS {
                tracing::error!(
                    age_ms = age,
                    threshold_ms = HEARTBEAT_TIMEOUT_MS,
                    "UI heartbeat lost — assuming WKWebView WebContent died. \
                     Triggering graceful shutdown."
                );
                app.exit(0);
                break;
            }
        }
    });
}

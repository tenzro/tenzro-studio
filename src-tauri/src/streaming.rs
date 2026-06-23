//! Streaming chat — Tauri `Channel<ChatEvent>` adapter over the core
//! streaming engine.
//!
//! The SSE parsing, cancellation, retry-on-model-not-found, and reasoning
//! / stop-string injection all live in `tenzro-studio-core::streaming`,
//! driven through its generic `ChatSink` trait. This module adapts that
//! trait to Tauri's `Channel<ChatEvent>` (the React side passes an
//! `onEvent` channel via `invoke('sidecar_chat_stream', { req, onEvent })`)
//! and keeps the two `#[tauri::command]` entry points.
//!
//! Core's `ChatEvent` derives `Serialize` with the same
//! `#[serde(tag = "kind", rename_all = "camelCase")]` shape the frontend
//! already consumes, so forwarding it over the channel is wire-compatible
//! with the previous in-app enum.

use tauri::ipc::Channel;
use tauri::State;

use crate::AppState;

pub use tenzro_studio_core::streaming::{ChatCancelArgs, ChatEvent, ChatStreamArgs};

/// Adapts a Tauri `Channel<ChatEvent>` to the core `ChatSink` trait. The
/// blanket `impl ChatSink for Fn(ChatEvent)` in core means we only need a
/// closure that forwards each event over the channel; a send failure
/// (channel dropped because the WebView navigated away mid-stream) is
/// ignored — the stream driver's cancellation path handles teardown.
fn channel_sink(on_event: Channel<ChatEvent>) -> impl Fn(ChatEvent) + Send + Sync {
    move |ev: ChatEvent| {
        let _ = on_event.send(ev);
    }
}

#[tauri::command]
pub async fn sidecar_chat_stream(
    hb: State<'_, std::sync::Arc<crate::watchdog::UiHeartbeat>>,
    args: ChatStreamArgs,
    on_event: Channel<ChatEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // The first stream against an unloaded model triggers a transparent
    // multi-GB load inside the router before any token comes back. That
    // load saturates CPU/GPU hard enough that WebKit throttles the
    // renderer's `requestAnimationFrame` heartbeat, so the watchdog reads
    // a stalled ping as a dead WebView and kills the app mid-load.
    // Hold a pause guard across the request so the watchdog stands
    // down. Once tokens start flowing
    // the renderer composites again and the heartbeat resumes; on a
    // frozen renderer the user can still cancel. The headless CLI has no
    // renderer heartbeat, so this guard is GUI-only and lives here.
    let _pause = hb.pause();
    let sink = channel_sink(on_event);
    tenzro_studio_core::streaming::sidecar_chat_stream(args, &sink, &state).await
}

#[tauri::command]
pub async fn sidecar_chat_cancel(
    args: ChatCancelArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tenzro_studio_core::streaming::cancel_stream(&state, &args.request_id).await
}

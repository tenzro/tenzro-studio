//! Streaming chat — Tauri Channel<T> wired to llama-server SSE.
//!
//! Tauri's docs explicitly state: "The event system is not designed
//! for low latency or high throughput situations. ... Channels are
//! the right primitive for streaming." We use a typed `Channel<ChatEvent>`
//! that the React side passes in via `invoke('sidecar_chat_stream',
//! { req, onEvent })`.
//!
//! Wire format (from llama.cpp tools/server/README.md, verified
//! against our ce3a35d build):
//!   data: {"choices":[{"delta":{"content":"..."}}], ...}\n\n
//!   data: {"choices":[{"delta":{},"finish_reason":"stop"}], "usage":{...}}\n\n
//!   data: [DONE]\n\n
//!
//! We forward each delta as `ChatEvent::Delta`, compute TTFT on the
//! first delta, surface the final `usage` block as `ChatEvent::Usage`,
//! and end with `ChatEvent::Done`. Cancellation: a per-request
//! `CancellationToken` in `AppState.inflight` — dropping the reqwest
//! response on cancel triggers llama-server's slot-cancel path
//! (llama.cpp #6421).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ChatStreamArgs {
    /// Opaque request id chosen by the UI so it can cancel a
    /// specific in-flight stream. UUIDs work fine.
    pub request_id: String,
    /// Full OpenAI-compatible chat-completion request body. Will be
    /// forwarded verbatim to the sidecar with `stream: true` +
    /// `stream_options.include_usage: true` injected.
    pub body: Value,
}

#[derive(Debug, Deserialize)]
pub struct ChatCancelArgs {
    pub request_id: String,
}

/// Typed event surface forwarded to the React side over the channel.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    /// Fires on the first delta. `ttft_ms` is wall-clock from the
    /// moment the Rust side issued the HTTP POST.
    Started { request_id: String, ttft_ms: u64 },
    /// One token (or BPE sub-word) chunk. The UI's rAF buffer
    /// coalesces these into one React commit per frame.
    Delta { content: String },
    /// llama.cpp's final stream-options chunk with usage + timings.
    /// `tok_per_sec` is the same number LM Studio shows under each
    /// message.
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        tok_per_sec: f64,
    },
    /// Stream terminated normally.
    Done { finish_reason: String },
    /// Stream terminated with an error (HTTP failure, parse failure,
    /// cancel, etc.). The UI surfaces this inline.
    Error { message: String },
}

/// In-flight cancellation tokens keyed by request id. Stored on
/// AppState so the cancel command can find the running request.
pub type InflightMap = Arc<Mutex<HashMap<String, CancellationToken>>>;

/// Hard ceiling on generated tokens when the caller doesn't specify
/// one. A correct model stops on EOS far sooner; this only bounds a
/// runaway (bad chat template / empty-token) model so it can't stream
/// forever. 4096 is generous for chat while still terminating.
const DEFAULT_MAX_TOKENS: u64 = 4096;

/// If the sidecar accepts the request but emits no SSE bytes for this
/// long, we abort the stream with an error instead of leaving the UI
/// pinned in `streaming: true`. Covers a model wedged before the first
/// token (e.g. Metal residency stall) or a silently dropped connection.
const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// ChatML control markers some broken GGUF templates leak as visible
/// text instead of treating as stop tokens. Passing them as explicit
/// `stop` strings makes llama-server halt generation on them, which
/// both terminates runaway output and keeps the markers out of the
/// rendered message.
const CHATML_STOP_MARKERS: &[&str] = &["<|im_end|>", "<|im_start|>"];

/// Internal sentinel prefixed onto a "model not found" error so the
/// chat command can recognise it, restart the sidecar (forcing a fresh
/// models-dir scan), and retry once. Stripped before the error ever
/// reaches the UI.
const MODEL_NOT_FOUND_TAG: &str = "__MODEL_NOT_FOUND__";

/// True when a sidecar error body is the router's "model not found"
/// 400 — the signature of a model that downloaded after the router
/// booted (the router scans the dir only at boot).
fn is_model_not_found(body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    b.contains("not found") && b.contains("model")
}

/// Merge our ChatML stop markers into the request body's `stop` array
/// without clobbering any caller-supplied stops.
fn inject_stop_strings(body: &mut Value) {
    let mut stops: Vec<Value> = match body.get("stop") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => vec![Value::from(s.clone())],
        _ => Vec::new(),
    };
    for marker in CHATML_STOP_MARKERS {
        let m = Value::from(*marker);
        if !stops.contains(&m) {
            stops.push(m);
        }
    }
    body["stop"] = Value::Array(stops);
}

#[tauri::command]
pub async fn sidecar_chat_stream(
    app: AppHandle,
    args: ChatStreamArgs,
    on_event: Channel<ChatEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Register a cancellation token for this request so the cancel
    // command can find it.
    let cancel = CancellationToken::new();
    {
        let mut inflight = state.inflight.lock().await;
        inflight.insert(args.request_id.clone(), cancel.clone());
    }

    // Inject stream + include_usage into the body, plus defensive
    // generation bounds so a misbehaving model (bad chat template that
    // never emits EOS, or empty-token runaway) can't generate forever
    // and hang the UI in `streaming: true`. We only set these when the
    // caller didn't, so an explicit request still wins.
    let mut body = args.body.clone();
    body["stream"] = Value::Bool(true);
    body["stream_options"] = serde_json::json!({"include_usage": true});
    if body.get("max_tokens").is_none() && body.get("n_predict").is_none() {
        body["max_tokens"] = Value::from(DEFAULT_MAX_TOKENS);
    }
    inject_stop_strings(&mut body);

    // Drive the stream, with a single retry on "model not found": that
    // 400 means the router booted before this model finished
    // downloading. Restarting the sidecar re-scans the models-dir, then
    // the retried request finds the model. The retry is only reached
    // when the first attempt failed at the HTTP-response stage, so no
    // partial output was forwarded to the UI.
    let mut result =
        run_once(&state, &body, &args.request_id, &on_event, &cancel).await;

    if let Err(e) = &result {
        if let Some(detail) = e.strip_prefix(MODEL_NOT_FOUND_TAG) {
            warn!(
                "Chat hit 'model not found' ({}); restarting sidecar to re-scan models-dir and retrying once",
                detail.trim()
            );
            match crate::sidecar::restart_sidecar(&app, &state).await {
                Ok(()) => {
                    result = run_once(&state, &body, &args.request_id, &on_event, &cancel)
                        .await
                        // Strip the tag on the retry so a still-missing
                        // model surfaces a clean message, not the sentinel.
                        .map_err(|e| {
                            e.strip_prefix(MODEL_NOT_FOUND_TAG)
                                .map(|d| format!("model not found:{}", d))
                                .unwrap_or(e)
                        });
                }
                Err(restart_err) => {
                    result = Err(format!(
                        "model not found and sidecar restart failed: {}",
                        restart_err
                    ));
                }
            }
        }
    }

    // Drop the cancellation entry regardless of outcome.
    {
        let mut inflight = state.inflight.lock().await;
        inflight.remove(&args.request_id);
    }

    if let Err(e) = &result {
        // Defensive: never leak the internal sentinel to the UI.
        let msg = e
            .strip_prefix(MODEL_NOT_FOUND_TAG)
            .map(|d| format!("model not found:{}", d))
            .unwrap_or_else(|| e.clone());
        let _ = on_event.send(ChatEvent::Error { message: msg });
    }
    result
}

/// Resolve the current sidecar URL and drive one stream attempt.
/// Separated so the chat command can re-invoke it after a sidecar
/// restart (which changes the port) without duplicating setup.
async fn run_once(
    state: &State<'_, AppState>,
    body: &Value,
    request_id: &str,
    on_event: &Channel<ChatEvent>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let base = {
        let guard = state.sidecar.read().await;
        let sidecar = guard
            .as_ref()
            .ok_or_else(|| "llama-server sidecar not ready yet".to_string())?;
        sidecar.base_url()
    };
    let url = format!("{}/v1/chat/completions", base);
    drive_stream(&url, body.clone(), request_id.to_string(), on_event.clone(), cancel.clone()).await
}

async fn drive_stream(
    url: &str,
    body: Value,
    request_id: String,
    on_event: Channel<ChatEvent>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let req_future = client.post(url).json(&body).send();

    let resp = tokio::select! {
        r = req_future => r.map_err(|e| format!("sidecar chat request failed: {}", e))?,
        _ = cancel.cancelled() => {
            return Err("cancelled".to_string());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        // A 400 "model not found" means the router booted before this
        // model finished downloading and hasn't re-scanned the dir.
        // Tag it so the caller can restart the sidecar + retry once.
        // Safe to retry: this fails at the HTTP-response stage, before
        // any Started/Delta event has been forwarded to the UI.
        if status.as_u16() == 400 && is_model_not_found(&body_text) {
            return Err(format!("{}{}", MODEL_NOT_FOUND_TAG, body_text));
        }
        return Err(format!("sidecar HTTP {}: {}", status, body_text));
    }

    let started = Instant::now();
    let mut first_delta = true;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut finish_reason = "stop".to_string();
    // Track whether any non-empty content reached the UI so we can
    // distinguish a genuine empty completion (bad model) from a normal
    // one and surface a clear error rather than a silent empty bubble.
    let mut emitted_content = false;

    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = cancel.cancelled() => {
                // Dropping `stream` (and the parent response) closes
                // the TCP socket. llama-server's slot-cancel path
                // (llama.cpp #6421) detects the disconnect and stops
                // the eval loop, freeing the slot.
                return Err("cancelled".to_string());
            }
            // Idle watchdog: no SSE bytes within the timeout means the
            // model is wedged before/between tokens. Abort so the UI
            // gets an error instead of an eternal streaming state.
            _ = tokio::time::sleep(STREAM_IDLE_TIMEOUT) => {
                return Err(format!(
                    "model produced no output for {}s — it may be misconfigured or stuck",
                    STREAM_IDLE_TIMEOUT.as_secs()
                ));
            }
        };
        let Some(chunk) = chunk else { break };
        let bytes = chunk.map_err(|e| format!("stream read failed: {}", e))?;
        buf.push_str(std::str::from_utf8(&bytes).unwrap_or(""));

        // SSE frames are delimited by a blank line ("\n\n"). Parse
        // every complete frame in the buffer, leaving any partial
        // tail for the next iteration.
        while let Some(idx) = buf.find("\n\n") {
            let frame: String = buf.drain(..idx + 2).collect();
            for line in frame.lines() {
                let Some(data) = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")) else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    if !emitted_content {
                        return Err(empty_output_error(&finish_reason));
                    }
                    let _ = on_event.send(ChatEvent::Done {
                        finish_reason: finish_reason.clone(),
                    });
                    return Ok(());
                }
                let value: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!("malformed SSE data line for {}: {} — {:?}", request_id, e, data);
                        continue;
                    }
                };
                // Delta content
                if let Some(content) = value
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|s| s.as_str())
                {
                    if first_delta {
                        first_delta = false;
                        let _ = on_event.send(ChatEvent::Started {
                            request_id: request_id.clone(),
                            ttft_ms: started.elapsed().as_millis() as u64,
                        });
                    }
                    if !content.is_empty() {
                        emitted_content = true;
                        let _ = on_event.send(ChatEvent::Delta {
                            content: content.to_string(),
                        });
                    }
                }
                // Finish reason
                if let Some(reason) = value
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("finish_reason"))
                    .and_then(|s| s.as_str())
                {
                    finish_reason = reason.to_string();
                }
                // Usage (final chunk under stream_options.include_usage)
                if let Some(usage) = value.get("usage").filter(|v| !v.is_null()) {
                    let prompt_tokens =
                        usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let completion_tokens = usage
                        .get("completion_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    // tok_per_sec from llama.cpp's `timings` block when present;
                    // otherwise computed from completion_tokens / elapsed.
                    let tok_per_sec = value
                        .get("timings")
                        .and_then(|t| t.get("predicted_per_second"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or_else(|| {
                            let secs = started.elapsed().as_secs_f64().max(0.001);
                            completion_tokens as f64 / secs
                        });
                    let _ = on_event.send(ChatEvent::Usage {
                        prompt_tokens,
                        completion_tokens,
                        tok_per_sec,
                    });
                }
            }
        }
    }

    // Server closed the stream without [DONE]. If nothing was ever
    // emitted this is a broken/empty generation, not a clean exit —
    // surface it so the UI shows an error instead of an empty bubble.
    if !emitted_content {
        return Err(empty_output_error(&finish_reason));
    }
    let _ = on_event.send(ChatEvent::Done { finish_reason });
    Ok(())
}

/// Human-readable error for a stream that completed without producing
/// any visible content. `finish_reason == "length"` means the model
/// hit the token cap generating only empty/whitespace tokens — the
/// signature of a broken chat template (no EOS). Anything else is a
/// model that returned nothing at all.
fn empty_output_error(finish_reason: &str) -> String {
    if finish_reason == "length" {
        "model produced no readable output (hit the token limit emitting empty tokens) \
         — its chat template is likely broken"
            .to_string()
    } else {
        "model produced no output".to_string()
    }
}

#[tauri::command]
pub async fn sidecar_chat_cancel(
    args: ChatCancelArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut inflight = state.inflight.lock().await;
    if let Some(token) = inflight.remove(&args.request_id) {
        token.cancel();
        Ok(())
    } else {
        Err(format!("no in-flight request with id {}", args.request_id))
    }
}

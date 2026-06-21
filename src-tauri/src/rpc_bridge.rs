//! In-process JSON-RPC bridge between the React frontend and the
//! embedded Tenzro node.
//!
//! The UI calls `invoke("rpc_call", { method, params })` and receives the
//! same JSON-RPC 2.0 response shape the public RPC endpoint emits. No
//! HTTP, no localhost port, no auth headers crossing a network boundary —
//! the embedded node enforces gates the same way it does over HTTP, but
//! the call is a plain function dispatch inside the Tauri process.

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct RpcCallArgs {
    /// JSON-RPC method name (e.g. `"tenzro_blockNumber"`).
    pub method: String,
    /// Method params. Accept either positional (`[...]`) or named (`{...}`)
    /// — the node dispatcher normalises both.
    #[serde(default)]
    pub params: Value,
    /// Optional admin token for node-scoped mutation RPCs. The UI prompts
    /// for it once (advanced settings) and re-uses across the session.
    #[serde(default)]
    pub admin_token: Option<String>,
    /// Optional API key for scope-gated namespaces (Canton, Chainlink).
    #[serde(default)]
    pub api_key: Option<String>,
}

#[tauri::command]
pub async fn rpc_call(args: RpcCallArgs, state: State<'_, AppState>) -> Result<Value, String> {
    let node = {
        let guard = state.node.read().await;
        guard
            .as_ref()
            .ok_or_else(|| "Node not running — start it first".to_string())?
            .node()
    };

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": args.method,
        "params": args.params,
        "id": 1,
    });

    let auth = tenzro_node::EmbeddedAuth {
        admin_token: args.admin_token,
        api_key: args.api_key,
        ..Default::default()
    };

    Ok(tenzro_node::dispatch_embedded(&node, request, auth).await)
}

/* --------------------------------------------------------------------- */
/* llama-server sidecar bridge                                            */
/* --------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct SidecarChatArgs {
    /// OpenAI-compatible chat-completion body. Forwarded verbatim to
    /// `POST /v1/chat/completions`.
    pub body: Value,
}

#[derive(Debug, Deserialize)]
pub struct SidecarLoadArgs {
    /// Absolute path to a GGUF file already downloaded by the node.
    pub model_path: String,
    /// Optional context length override. The sidecar picks a sensible
    /// default from the GGUF metadata when omitted.
    #[serde(default)]
    pub n_ctx: Option<u32>,
    /// Optional GPU offload override. Sidecar auto-detects when None.
    #[serde(default)]
    pub n_gpu_layers: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarUnloadArgs {
    /// Model alias / id to unload. llama-server v1 supports multi-
    /// model serving; we pass the alias we registered at load time.
    pub model_id: String,
}

async fn sidecar_base(state: &State<'_, AppState>) -> Result<String, String> {
    let guard = state.sidecar.read().await;
    let sidecar = guard
        .as_ref()
        .ok_or_else(|| "llama-server sidecar not ready yet".to_string())?;
    Ok(sidecar.base_url())
}

/// Proxy a chat-completion request to the sidecar. Returns the raw
/// JSON response. Streaming is handled separately via the UI's own
/// fetch path against the sidecar's `/v1/chat/completions` endpoint
/// (the Tauri command path is JSON-only).
#[tauri::command]
pub async fn sidecar_chat(
    app: AppHandle,
    args: SidecarChatArgs,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    match sidecar_chat_once(&state, &args.body).await {
        Ok(body) => Ok(body),
        Err(ChatErr::ModelNotFound(detail)) => {
            // Router booted before this model finished downloading.
            // Restart so it re-scans the models-dir, then retry once.
            tracing::warn!(
                "sidecar_chat hit 'model not found' ({}); restarting sidecar and retrying once",
                detail.trim()
            );
            crate::sidecar::restart_sidecar(&app, &state)
                .await
                .map_err(|e| format!("model not found and sidecar restart failed: {}", e))?;
            match sidecar_chat_once(&state, &args.body).await {
                Ok(body) => Ok(body),
                Err(ChatErr::ModelNotFound(d)) => {
                    Err(format!("model not found:{}", d))
                }
                Err(ChatErr::Other(e)) => Err(e),
            }
        }
        Err(ChatErr::Other(e)) => Err(e),
    }
}

enum ChatErr {
    /// Router 400 "model not found" — retryable after a sidecar restart.
    ModelNotFound(String),
    /// Any other failure — surfaced to the UI verbatim.
    Other(String),
}

async fn sidecar_chat_once(
    state: &State<'_, AppState>,
    body: &Value,
) -> Result<Value, ChatErr> {
    let base = sidecar_base(state)
        .await
        .map_err(ChatErr::Other)?;
    let url = format!("{}/v1/chat/completions", base);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| ChatErr::Other(format!("sidecar chat request failed: {}", e)))?;
    let status = resp.status();
    let resp_body: Value = resp
        .json()
        .await
        .map_err(|e| ChatErr::Other(format!("sidecar chat response parse failed: {}", e)))?;
    if !status.is_success() {
        let body_str = resp_body.to_string().to_ascii_lowercase();
        if status.as_u16() == 400 && body_str.contains("not found") && body_str.contains("model") {
            return Err(ChatErr::ModelNotFound(resp_body.to_string()));
        }
        return Err(ChatErr::Other(format!("sidecar chat HTTP {}: {}", status, resp_body)));
    }
    Ok(resp_body)
}

/// Explicit load via the canonical llama.cpp router endpoint
/// `POST /models/load`. The router mode also supports transparent
/// auto-load on first `/v1/chat/completions` referencing the model in
/// the `model` field, so this is optional — call it only if the UI
/// wants to surface a "Loading…" state before the first chat token.
#[tauri::command]
pub async fn sidecar_load_model(
    args: SidecarLoadArgs,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let base = sidecar_base(&state).await?;
    let url = format!("{}/models/load", base);
    let client = reqwest::Client::new();
    // llama.cpp router takes the model by its `model_path` (filename
    // within the models-dir, or absolute path). Optional context size
    // + GPU layer overrides ride alongside.
    let mut body = serde_json::json!({
        "model": args.model_path,
    });
    if let Some(n) = args.n_ctx {
        body["n_ctx"] = serde_json::json!(n);
    }
    if let Some(n) = args.n_gpu_layers {
        body["n_gpu_layers"] = serde_json::json!(n);
    }
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sidecar load request failed: {}", e))?;
    let status = resp.status();
    let resp_body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("sidecar load HTTP {}: {}", status, resp_body));
    }
    Ok(resp_body)
}

/// Unload a model from the router. Calls `POST /models/unload`.
#[tauri::command]
pub async fn sidecar_unload_model(
    args: SidecarUnloadArgs,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let base = sidecar_base(&state).await?;
    let url = format!("{}/models/unload", base);
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "model": args.model_id });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sidecar unload request failed: {}", e))?;
    let status = resp.status();
    let resp_body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("sidecar unload HTTP {}: {}", status, resp_body));
    }
    Ok(resp_body)
}

/// List the models the sidecar's router has discovered in its
/// `--models-dir`. Returns whatever `GET /models` emits — typically
/// each model's status (`loaded` / `loading` / `unloaded`) and
/// metadata. Used by the UI to drive the local-model picker so we
/// only offer models the sidecar can actually serve.
#[tauri::command]
pub async fn sidecar_list_models(state: State<'_, AppState>) -> Result<Value, String> {
    let base = sidecar_base(&state).await?;
    let url = format!("{}/models", base);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("sidecar list request failed: {}", e))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("sidecar list HTTP {}: {}", status, body));
    }
    Ok(body)
}

/// Restart the sidecar so its router re-scans `--models-dir`. The
/// router only scans the dir at boot, so a model that finished
/// downloading after the sidecar started is invisible until we
/// restart. The UI calls this when a download transitions to complete
/// (before auto-loading the new model) so the freshly-downloaded GGUF
/// becomes chattable without an app restart.
#[tauri::command]
pub async fn sidecar_refresh_models(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    crate::sidecar::restart_sidecar(&app, &state).await?;
    Ok(serde_json::json!({ "refreshed": true }))
}

/// Return the sidecar base URL + a coarse status flag so the UI can
/// show whether the inference engine is ready. Used by the Run Local
/// flow before attempting a chat.
#[tauri::command]
pub async fn sidecar_status(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.sidecar.read().await;
    match guard.as_ref() {
        Some(sidecar) => {
            let base = sidecar.base_url();
            // Probe /health so the UI knows whether the engine is
            // alive AND model-loaded. 200 = ready, 503 = loading,
            // anything else = down.
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(500))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            let url = format!("{}/health", base);
            let health = client.get(&url).send().await;
            let (alive, code) = match health {
                Ok(r) => (true, r.status().as_u16()),
                Err(_) => (false, 0),
            };
            Ok(serde_json::json!({
                "spawned": true,
                "base_url": base,
                "port": sidecar.port,
                "alive": alive,
                "http_status": code,
            }))
        }
        None => Ok(serde_json::json!({ "spawned": false })),
    }
}

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

/// Combined model details: catalog metadata + on-disk facts (size, path,
/// whether the per-model sidecar has it loaded). The UI's details panel
/// calls this with the model `id`; the response is everything the panel
/// needs in one round-trip.
///
/// Catalog facts come from `tenzro_modelMetadata` (the public RPC); the
/// `local` block is computed here. Returns `null` for unknown ids so the
/// UI can show "this model isn't in the network catalog" without
/// erroring.
#[tauri::command]
pub async fn model_details(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let Some(entry) = tenzro_model::catalog::get_model_by_id(&id) else {
        return Ok(Value::Null);
    };

    // On-disk: the downloader writes <download_filename> under models_dir.
    // For sharded entries the field is "subdir/first-shard.gguf" — we
    // need to total the subdir AND check existence on the first shard.
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let models_dir = home.join(".tenzro").join("models");
    let path_rel = if entry.download_filename.is_empty() {
        format!("{}.gguf", entry.id)
    } else {
        entry.download_filename.clone()
    };
    let model_path = models_dir.join(&path_rel);
    let (downloaded, on_disk_bytes, on_disk_path) = if model_path.exists() {
        let size = std::fs::metadata(&model_path)
            .map(|m| m.len())
            .unwrap_or(0);
        (true, size, Some(model_path.display().to_string()))
    } else if model_path.parent().map(|p| p.exists()).unwrap_or(false)
        && path_rel.contains('/')
    {
        // Sharded layout — sum every .gguf inside the subdir.
        let dir = model_path.parent().unwrap();
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.path().extension().and_then(|s| s.to_str()) == Some("gguf") {
                    if let Ok(m) = e.metadata() {
                        total += m.len();
                    }
                }
            }
        }
        let exists = total > 0;
        (exists, total, exists.then(|| dir.display().to_string()))
    } else {
        (false, 0, None)
    };

    // Mmproj sidecar file (vision-capable entries only).
    let mmproj_path = entry
        .mmproj
        .as_ref()
        .map(|_| models_dir.join(format!("{}.mmproj.gguf", entry.id)));
    let mmproj_present = mmproj_path
        .as_ref()
        .map(|p| p.exists())
        .unwrap_or(false);
    let mmproj_bytes = mmproj_path
        .as_ref()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    // Is this model currently loaded by the per-model llama-server router?
    // We probe the sidecar's /v1/models endpoint and look for status.value == "loaded".
    let loaded = sidecar_has_loaded(&state, &entry.id).await;

    let moe = entry.moe.map(|m| {
        serde_json::json!({
            "num_experts": m.num_experts,
            "experts_per_token": m.experts_per_token,
            "shared_experts": m.shared_experts,
            "params_per_expert_x10": m.params_per_expert_x10,
        })
    });

    let template_fix_kind = match &entry.template_fix {
        tenzro_model::catalog::TemplateFix::None => "none",
        tenzro_model::catalog::TemplateFix::Vendored { .. } => "vendored",
    };

    Ok(serde_json::json!({
        "id": entry.id,
        "name": entry.name,
        "family": entry.family,
        "description": entry.description,
        "license": entry.license,
        "hf_repo": entry.hf_repo,
        "parameters": entry.parameters,
        "architecture": format!("{:?}", entry.architecture),
        "context_length": entry.context_length,
        "quantization": entry.quantization,
        "min_ram_gb": entry.min_ram_gb,
        "promotable": entry.promotable,
        "catalog_size_bytes": entry.size_bytes,
        "serving": {
            "temperature": entry.serving.temperature,
            "top_p": entry.serving.top_p,
            "top_k": entry.serving.top_k,
            "min_p": entry.serving.min_p,
            "jinja_required": entry.serving.jinja_required,
        },
        "reasoning": {
            "supports_thinking": entry.reasoning.supports_thinking,
            "default_mode": format!("{:?}", entry.reasoning.default_mode).to_lowercase(),
            "thinking_safe_min_b": entry.reasoning.thinking_safe_min_b,
            "thinking_min_budget_tokens": entry.reasoning.thinking_min_budget_tokens,
        },
        "template_fix": template_fix_kind,
        "moe": moe,
        "mtp_kind": format!("{:?}", entry.mtp_kind).to_lowercase(),
        "drafter_id": entry.drafter_id,
        "mmproj_required": entry.mmproj.is_some(),
        "local": {
            "downloaded": downloaded,
            "on_disk_bytes": on_disk_bytes,
            "on_disk_path": on_disk_path,
            "download_filename": path_rel,
            "mmproj_present": mmproj_present,
            "mmproj_bytes": mmproj_bytes,
            "loaded_in_sidecar": loaded,
        },
    }))
}

/// Probe the sidecar's `/v1/models` endpoint for this model id and
/// return true iff status.value == "loaded". Tolerates a missing
/// sidecar (returns false).
async fn sidecar_has_loaded(state: &State<'_, AppState>, id: &str) -> bool {
    let base = {
        let guard = state.sidecar.read().await;
        match guard.as_ref() {
            Some(sc) => sc.base_url(),
            None => return false,
        }
    };
    let url = format!("{}/v1/models", base);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let Ok(resp) = client.get(&url).send().await else {
        return false;
    };
    let Ok(body) = resp.json::<Value>().await else {
        return false;
    };
    body.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter().any(|m| {
                m.get("id").and_then(|v| v.as_str()) == Some(id)
                    && m.get("status")
                        .and_then(|s| s.get("value"))
                        .and_then(|v| v.as_str())
                        == Some("loaded")
            })
        })
        .unwrap_or(false)
}

/// Remove a downloaded model from disk to reclaim space. Safety:
///
/// - Refuses if the model is currently `"loaded"` in the per-model
///   sidecar — caller must unload first (UI surfaces this as a friendly
///   error so the user can stop the chat and retry).
/// - Removes the GGUF (flat or sharded subdir), the mmproj projector
///   if present, and any matching `.tmp` / `.partial` from a prior
///   interrupted download.
/// - Regenerates the preset INI so the router's next rescan no longer
///   advertises this model. The router itself only re-scans on
///   restart; the UI should call `sidecar_refresh_models` after
///   offloading so the change takes effect without an app restart.
///
/// Returns the number of bytes freed (for UI confirmation) on success.
/// The catalog entry itself is untouched — the user can re-download
/// any time.
#[tauri::command]
pub async fn offload_model(
    id: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let entry = tenzro_model::catalog::get_model_by_id(&id)
        .ok_or_else(|| format!("unknown model id: {}", id))?;

    if sidecar_has_loaded(&state, &id).await {
        return Err(
            "model is currently loaded in the inference engine — stop the chat first, then retry"
                .to_string(),
        );
    }

    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let models_dir = home.join(".tenzro").join("models");

    let path_rel = if entry.download_filename.is_empty() {
        format!("{}.gguf", entry.id)
    } else {
        entry.download_filename.clone()
    };

    let mut freed: u64 = 0;
    let mut removed_paths: Vec<String> = Vec::new();

    // Main GGUF (flat) OR sharded subdir.
    let main_path = models_dir.join(&path_rel);
    if path_rel.contains('/') {
        // Sharded layout — remove the entire subdir.
        if let Some(subdir) = main_path.parent() {
            if subdir.exists() && subdir != models_dir {
                if let Ok(rd) = std::fs::read_dir(subdir) {
                    for e in rd.flatten() {
                        if let Ok(m) = e.metadata() {
                            freed += m.len();
                        }
                    }
                }
                std::fs::remove_dir_all(subdir)
                    .map_err(|e| format!("failed to remove {}: {}", subdir.display(), e))?;
                removed_paths.push(subdir.display().to_string());
            }
        }
    } else if main_path.exists() {
        if let Ok(m) = std::fs::metadata(&main_path) {
            freed += m.len();
        }
        std::fs::remove_file(&main_path)
            .map_err(|e| format!("failed to remove {}: {}", main_path.display(), e))?;
        removed_paths.push(main_path.display().to_string());
    }

    // Mmproj sidecar file.
    if entry.mmproj.is_some() {
        let mmproj_path = models_dir.join(format!("{}.mmproj.gguf", entry.id));
        if mmproj_path.exists() {
            if let Ok(m) = std::fs::metadata(&mmproj_path) {
                freed += m.len();
            }
            std::fs::remove_file(&mmproj_path)
                .map_err(|e| format!("failed to remove {}: {}", mmproj_path.display(), e))?;
            removed_paths.push(mmproj_path.display().to_string());
        }
    }

    // Reap any partial-download leftovers keyed on this id.
    for suffix in [".tmp", ".partial", ".download", ".gguf.tmp"] {
        let p = models_dir.join(format!("{}{}", entry.id, suffix));
        if p.exists() {
            if let Ok(m) = std::fs::metadata(&p) {
                freed += m.len();
            }
            let _ = std::fs::remove_file(&p);
            removed_paths.push(p.display().to_string());
        }
    }

    tracing::info!(
        model_id = %id,
        freed_bytes = freed,
        removed_paths = ?removed_paths,
        "Offloaded model from disk"
    );

    Ok(freed)
}

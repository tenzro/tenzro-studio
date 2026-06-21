//! llama-server sidecar process management.
//!
//! Pattern (per SOTA research on Ollama / LM Studio / Jan v0.8): the
//! llama.cpp inference engine runs as a separate OS process, not linked
//! into the Tauri UI binary. Crash isolation is the headline win — a
//! Metal residency-set abort or CUDA OOM kills the sidecar, the UI
//! catches the exit and can restart cleanly. Secondary wins:
//!
//! - VRAM reclamation: `kill -9` on the subprocess is the only reliable
//!   way to release Metal/CUDA buffers on macOS/Linux drivers.
//! - Hot model swap: `POST /models/unload` + `/models/load` to the
//!   sidecar, no UI restart.
//! - Same OpenAI-compatible HTTP surface serves the UI and any
//!   third-party tool the user points at `localhost:<port>`.
//!
//! Discovery: random free port at startup, exposed via the
//! [`SidecarHandle::base_url`] accessor so Tauri commands can build
//! request URLs without hard-coded ports.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tauri::AppHandle;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tokio::sync::OnceCell;
use tracing::{info, warn};

use crate::hardware::HardwareProfile;

/// Sidecar lifecycle handle. Held in Tauri-managed state for the
/// lifetime of the app. Stop the sidecar on shutdown via
/// [`SidecarHandle::stop`].
pub struct SidecarHandle {
    /// Bound port on `127.0.0.1` the sidecar is listening on.
    pub port: u16,
    /// Tokio process handle. Wrapped in `RwLock<Option<...>>` so the
    /// stop path can take it without holding the lock across `await`.
    child: RwLock<Option<Child>>,
}

impl SidecarHandle {
    /// Base URL for OpenAI-compatible requests. Most callers want this
    /// + an `/v1/...` path.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Send SIGTERM, wait briefly, escalate to SIGKILL. Per the SOTA
    /// research, `kill -9` is the only reliable way to release Metal
    /// / CUDA buffers on macOS / Linux drivers — we wait 3 s for a
    /// graceful exit, then force-kill so the next launch has a clean
    /// slate.
    pub async fn stop(&self) {
        let mut guard = self.child.write().await;
        let Some(mut child) = guard.take() else {
            return;
        };
        // tokio's `kill()` is SIGKILL on Unix; for graceful first we
        // shell out to `kill -TERM <pid>`. If pid is unavailable
        // (already-exited race) just skip to SIGKILL.
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status();
        }
        match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
            Ok(Ok(status)) => {
                info!("llama-server exited gracefully: {}", status);
            }
            Ok(Err(e)) => {
                warn!("llama-server wait error: {}", e);
            }
            Err(_) => {
                warn!("llama-server did not exit on SIGTERM within 3s — sending SIGKILL");
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
    }
}

/// Spawn the llama-server sidecar in **router mode** with the user's
/// model directory pre-registered. Router mode is the canonical 2026
/// pattern (Jan v0.8.0 migrated to it from kill-and-respawn; LM Studio
/// shipping with multi-model serving). The router auto-discovers every
/// GGUF in `--models-dir`, exposes them via `GET /models`, and
/// transparently loads on first `/v1/chat/completions` request that
/// references their filename in the `model` field. Hot-swap is free —
/// changing the `model` field across requests triggers LRU eviction +
/// load without restart.
pub async fn spawn_sidecar(app: &AppHandle) -> Result<Arc<SidecarHandle>, String> {
    let bin = resolve_sidecar_path(app)?;

    // Reap orphaned sidecars from a previously crashed/force-quit app
    // instance before spawning our own. A llama-server whose parent
    // already died (re-parented to launchd/init, ppid==1) keeps the
    // GGUF resident on Metal and contends for residency sets with the
    // fresh child — the documented cause of inference hangs after a
    // crash. We only touch processes running OUR sidecar binary so a
    // second legitimately-running app instance is never disturbed.
    reap_orphaned_sidecars(&bin);

    // Models live at ~/.tenzro/models/ (where tenzro-node's
    // HfDownloader writes them). Ensure the dir exists so llama-server
    // doesn't refuse to start on a fresh install.
    let home = dirs::home_dir()
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    let models_dir = home.join(".tenzro").join("models");
    let _ = std::fs::create_dir_all(&models_dir);

    info!(
        "Spawning llama-server sidecar (router mode) from {} with models-dir {}",
        bin.display(),
        models_dir.display()
    );

    let port = pick_free_port()?;

    // Probe the host and pick llama-server flags per profile (RAM
    // tier, physical core count, GPU class). See `hardware.rs` for
    // the per-flag policy table.
    let profile = HardwareProfile::detect();
    let ctx_size = profile.ctx_size();
    let batch_size = profile.batch_size(ctx_size);
    let ubatch_size = profile.ubatch_size(ctx_size);
    let n_gpu_layers = profile.n_gpu_layers();
    let threads = profile.threads();
    info!(
        "Hardware profile: gpu={:?}, ram={} GB, cores={} → ngl={}, ctx={}, batch={}/{}, threads={}",
        profile.gpu_class,
        profile.ram_gb,
        profile.physical_cores,
        n_gpu_layers,
        ctx_size,
        batch_size,
        ubatch_size,
        threads,
    );

    // Generate a presets INI on the fly so we can override the
    // embedded jinja template for known-broken models (Qwen 3.5/3.6,
    // GLM 4.6 — see llama.cpp #13178, froggeric/Qwen-Fixed-Chat-
    // Templates, unsloth/GLM-4.6-GGUF #2). When no overrides apply
    // we still use the file because the router lets us bake in our
    // GPU-layers + ctx-size defaults per preset.
    let preset_path =
        generate_models_preset(&models_dir, &home, &profile, ctx_size).await?;

    // On unified-memory hosts (Apple Silicon, Intel iGPU, AMD APU,
    // CPU-only) we wrap the sidecar in `taskpolicy -c utility`
    // (macOS) or `nice -n 10` (Linux) so it runs at a lower QoS
    // class than WindowServer / the desktop compositor. The shared
    // GPU then yields display work first instead of fighting the
    // compositor for the same surface — the documented fix for the
    // M-series whole-screen flicker (U14 root cause). Discrete-GPU
    // machines don't need this and Windows has no userspace
    // equivalent without admin.
    // The QoS-demotion wrapper is best-effort: if the wrapper binary
    // isn't where we expect, we MUST fall back to spawning the sidecar
    // directly rather than fail the whole spawn with ENOENT. (taskpolicy
    // lives at /usr/sbin/taskpolicy on macOS — NOT /usr/bin — and may be
    // absent on some images; missing QoS demotion only risks cosmetic
    // GPU flicker, whereas a failed spawn means no inference at all.)
    let (program, args_prefix): (PathBuf, Vec<String>) = if profile.demote_gpu_qos() {
        #[cfg(target_os = "macos")]
        {
            let wrapper = PathBuf::from("/usr/sbin/taskpolicy");
            if wrapper.exists() {
                (
                    wrapper,
                    vec!["-c".to_string(), "utility".to_string(), bin.display().to_string()],
                )
            } else {
                warn!("/usr/sbin/taskpolicy not found — spawning sidecar without QoS demotion");
                (bin.clone(), Vec::<String>::new())
            }
        }
        #[cfg(target_os = "linux")]
        {
            let wrapper = PathBuf::from("/usr/bin/nice");
            if wrapper.exists() {
                (
                    wrapper,
                    vec!["-n".to_string(), "10".to_string(), bin.display().to_string()],
                )
            } else {
                warn!("/usr/bin/nice not found — spawning sidecar without QoS demotion");
                (bin.clone(), Vec::<String>::new())
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            (bin.clone(), Vec::<String>::new())
        }
    } else {
        (bin.clone(), Vec::<String>::new())
    };

    let mut cmd = Command::new(&program);
    for a in &args_prefix {
        cmd.arg(a);
    }
    cmd.arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        // Router mode: scans `models-dir` and exposes each GGUF as a
        // routable model. Auto-loads on first chat request that
        // references the model by filename. Preset file layers per-
        // model overrides on top.
        .arg("--models-dir").arg(&models_dir)
        .arg("--models-preset").arg(&preset_path)
        // Single user, single concurrent request — queue in UI.
        .arg("--parallel").arg("1")
        // HTTP listener thread count. Default is host CPU count which
        // floods the request queue when streaming. 2 is enough for
        // one streaming chat + a `/models` poll from the UI without
        // ever queuing.
        .arg("--threads-http").arg("2")
        // Jinja chat-template processing for tool calling +
        // model-specific formatting.
        .arg("--jinja")
        // All four hot-path knobs are picked by `HardwareProfile`
        // above so a 6 GB Pi, a 16 GB M-series, and a 96 GB
        // RTX-equipped workstation each get appropriate values.
        .arg("--n-gpu-layers").arg(n_gpu_layers.to_string())
        .arg("--batch-size").arg(batch_size.to_string())
        .arg("--ubatch-size").arg(ubatch_size.to_string())
        .arg("--threads").arg(threads.to_string())
        .arg("--ctx-size").arg(ctx_size.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {}", e))?;

    let base_url = format!("http://127.0.0.1:{}", port);
    let healthy = wait_for_health(&base_url, std::time::Duration::from_secs(15)).await;
    if !healthy {
        warn!("llama-server failed to report healthy within 15s");
    }

    Ok(Arc::new(SidecarHandle {
        port,
        child: RwLock::new(Some(child)),
    }))
}

/// Restart the running sidecar so its router re-scans `--models-dir`.
///
/// The llama.cpp router scans the models directory exactly ONCE at
/// boot (verified against our build: there is no `/models/reload`,
/// `--watch`, or rescan flag — only `/models/load` + `/models/unload`,
/// which act on already-discovered models). A GGUF that finishes
/// downloading AFTER the sidecar booted is therefore invisible and any
/// chat referencing it 400s with `model '<id>' not found`. The only
/// reliable way to surface a newly-downloaded model is to restart the
/// process so it re-scans the dir.
///
/// Stops the current handle (SIGTERM→SIGKILL, freeing Metal/CUDA
/// buffers) and spawns a fresh one, swapping it into `AppState` under
/// the write lock. Idempotent enough to call from both the
/// download-complete hook and the chat-400 backstop.
/// Serialise concurrent `restart_sidecar` callers. Two restart paths
/// (download-complete UI hook + chat-400 model-not-found backstop) can
/// fire within ms of each other; without this lock the second caller
/// would observe `state.sidecar` as `None` (the first already took it),
/// skip the stop, spawn a second fresh sidecar, then overwrite the
/// first's freshly-spawned handle in AppState — leaking a live
/// llama-server process whose parent is `ipnops-edge` (so `ppid!=1` →
/// boot-time `reap_orphaned_sidecars` won't catch it either).
static RESTART_LOCK: OnceCell<Mutex<()>> = OnceCell::const_new();

pub async fn restart_sidecar(
    app: &AppHandle,
    state: &crate::AppState,
) -> Result<(), String> {
    let lock = RESTART_LOCK.get_or_init(|| async { Mutex::new(()) }).await;
    let _restart_guard = lock.lock().await;
    info!("Restarting llama-server sidecar to re-scan models-dir");
    // Take the old handle out first so a concurrent caller can't also
    // stop it, then stop it (releases Metal/CUDA + frees the port).
    let old = {
        let mut guard = state.sidecar.write().await;
        guard.take()
    };
    if let Some(old) = old {
        old.stop().await;
    }
    // Spawn fresh — this re-runs the dir scan + preset generation so
    // any model downloaded since the last boot is now routable.
    let fresh = spawn_sidecar(app).await?;
    {
        let mut guard = state.sidecar.write().await;
        if let Some(stray) = guard.take() {
            // Defensive: if some other path swapped a sidecar in
            // between our spawn and our write-lock acquire, stop it
            // before we overwrite — otherwise it leaks as a
            // non-orphan stray (parent is still ipnops-edge).
            warn!("Sidecar swapped concurrently during restart — stopping stray before swap");
            stray.stop().await;
        }
        *guard = Some(fresh);
    }
    info!("llama-server sidecar restarted — models-dir re-scanned");
    Ok(())
}

fn resolve_sidecar_path(_app: &AppHandle) -> Result<PathBuf, String> {
    // Tauri ships externalBin entries by renaming
    // `binaries/llama-server-<target-triple>` to plain `llama-server`
    // and dropping the result next to the main executable in the
    // bundle. On macOS that's `<bundle>/Contents/MacOS/llama-server`;
    // on Linux it's the same directory as the main binary; on
    // Windows it's `<install>/llama-server.exe`. Looking next to the
    // current exe is the cross-platform-correct path — and far more
    // reliable than asking Tauri's path resolver, which has
    // surprising behaviour for externalBin entries.
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            let candidates = [
                dir.join("llama-server"),
                dir.join("llama-server.exe"), // Windows
            ];
            for c in &candidates {
                if c.exists() {
                    return Ok(c.clone());
                }
            }
        }
    }

    // Dev-mode fall back: the binary may be in `src-tauri/binaries/`
    // for hand-testing without going through `tauri build`.
    let dev_paths = [
        "src-tauri/binaries/llama-server-aarch64-apple-darwin",
        "src-tauri/binaries/llama-server-x86_64-apple-darwin",
        "src-tauri/binaries/llama-server-aarch64-unknown-linux-gnu",
        "src-tauri/binaries/llama-server-x86_64-unknown-linux-gnu",
        "src-tauri/binaries/llama-server-x86_64-pc-windows-msvc.exe",
    ];
    if let Ok(cwd) = std::env::current_dir() {
        for rel in &dev_paths {
            let p = cwd.join(rel);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    Err(format!(
        "llama-server sidecar binary not found next to the main exe ({:?}) or in src-tauri/binaries/ — re-run `tauri build` after `scripts/build-sidecar.sh`",
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
    ))
}

/// Kill llama-server processes that (a) run our sidecar binary and
/// (b) have been orphaned (ppid == 1) by a dead parent app. Best-effort
/// and Unix-only — on Windows orphaned children are cleaned up by the
/// job-object `kill_on_drop` path so there is nothing to sweep.
#[cfg(unix)]
fn reap_orphaned_sidecars(bin: &std::path::Path) {
    let bin_str = bin.to_string_lossy();
    // `ps -axo pid=,ppid=,comm=` is portable across macOS and Linux.
    // We match on the binary name in `comm`/`command`; comm can be
    // truncated, so we also check the full command via `command=`.
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output();
    let Ok(output) = output else {
        return;
    };
    let listing = String::from_utf8_lossy(&output.stdout);
    let self_pid = std::process::id();
    for line in listing.lines() {
        let mut parts = line.trim().splitn(3, char::is_whitespace);
        let (Some(pid_s), Some(ppid_s), Some(cmd)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // Only orphans (re-parented to init/launchd) running our binary.
        if ppid_s.trim() != "1" || !cmd.contains(bin_str.as_ref()) {
            continue;
        }
        let Ok(pid) = pid_s.trim().parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        info!("Reaping orphaned llama-server (pid={}) from a prior app instance", pid);
        // SIGKILL directly: an orphaned sidecar has no parent to drain
        // it gracefully and we want its Metal residency freed now.
        let _ = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .status();
    }
}

#[cfg(not(unix))]
fn reap_orphaned_sidecars(_bin: &std::path::Path) {}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind ephemeral port: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to read bound port: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

/// Known-broken chat-template prefixes. Each prefix in this list is
/// matched against the GGUF stem (filename without `.gguf`) — when
/// present, we override the GGUF's embedded jinja template with our
/// vendored fix. Sources: llama.cpp #13178, froggeric/Qwen-Fixed-Chat-
/// Templates (Qwen 3.5/3.6 prompt-drop bug); unsloth/GLM-4.6-GGUF #2
/// (GLM-4.5/4.6 think-tag handling).
///
/// To add a new override:
/// 1. Drop the fixed jinja into `src-tauri/templates/<family>.jinja`.
/// 2. Add `("<prefix>", "<family>.jinja")` to this list.
/// 3. The preset generator will wire `--chat-template-file <path>`
///    into that model's INI section on next spawn.
const TEMPLATE_OVERRIDES: &[(&str, &str)] = &[
    // Vendored overrides not yet checked in — the override map is
    // ready to receive them. Until templates are vendored, this list
    // is empty and every GGUF uses its embedded template (current
    // behaviour). Adding a row here + dropping the jinja file is the
    // entire enable path.
];

/// Build a per-model preset INI from the GGUFs in `models_dir`.
///
/// Each discovered GGUF is matched back to its catalog entry
/// ([`tenzro_model::catalog`]) by filename, and the entry's
/// [`ServingProfile`](tenzro_model::catalog::ServingProfile) drives the
/// per-model sampler defaults (`temperature`, `top-p`, `top-k`, `min-p`),
/// the `--jinja` toggle, and — for speculative-decoding / MoE models — the
/// `--spec-type` / `--spec-draft-n-max` / `--n-cpu-moe` flags. The catalog
/// is the single source of truth for serving config (see the
/// serving-profile architecture decision); this generator only translates
/// it into llama-server preset INI keys and layers the host's
/// [`HardwareProfile`] hardware knobs on top.
async fn generate_models_preset(
    models_dir: &std::path::Path,
    home: &std::path::Path,
    profile: &HardwareProfile,
    ctx_size: u32,
) -> Result<PathBuf, String> {
    let preset_dir = home.join(".tenzro/inference");
    let _ = std::fs::create_dir_all(&preset_dir);
    let preset_path = preset_dir.join("llama-server-presets.ini");

    let templates_dir = templates_dir();
    let n_gpu_layers = profile.n_gpu_layers();
    let batch_size = profile.batch_size(ctx_size);
    let ubatch_size = profile.ubatch_size(ctx_size);
    let threads = profile.threads();

    // Index the catalog by GGUF filename stem so each on-disk model can be
    // matched to its serving profile / MTP / MoE metadata. `hf_filename`
    // may carry a sharded subdir prefix (e.g. `Q4_K_M/Model-...-00001-of-
    // 000NN.gguf`); we key on the bare filename stem, which is what the
    // router sees on disk.
    use std::collections::HashMap;
    use tenzro_model::catalog::{MtpKind, get_model_catalog};
    let catalog = get_model_catalog();
    let by_stem: HashMap<String, &tenzro_model::catalog::HfModelEntry> = catalog
        .iter()
        .filter_map(|e| {
            let file = e.hf_filename.rsplit('/').next()?;
            let stem = file.strip_suffix(".gguf")?;
            Some((stem.to_string(), e))
        })
        .collect();

    let mut ini = String::new();
    ini.push_str("# Generated by ipnops-edge on app start.\n");
    ini.push_str("# DO NOT EDIT — overwritten on each launch.\n\n");

    let Ok(entries) = std::fs::read_dir(models_dir) else {
        // Empty file is valid INI; router will fall back to its
        // own auto-discovery.
        let _ = std::fs::write(&preset_path, &ini);
        return Ok(preset_path);
    };

    // Collect each servable model as (stem, gguf_path). Top-level
    // `*.gguf` are single-file models. Sharded (gguf-split) models are
    // downloaded into a per-id subdir; we descend one level and pick the
    // FIRST shard (`...-00001-of-000NN.gguf`) — llama.cpp auto-continues
    // the rest of the set from there. The stem keeps the shard suffix so
    // it matches `by_stem`, which is keyed on the catalog's bare filename
    // stem (also the first shard).
    let mut models: Vec<(String, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(sub) = std::fs::read_dir(&path) {
                for shard in sub.flatten() {
                    let sp = shard.path();
                    let Some(sn) = sp.file_name().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    if sn.contains("-00001-of-")
                        && let Some(stem) = sn.strip_suffix(".gguf")
                    {
                        models.push((stem.to_string(), sp.clone()));
                    }
                }
            }
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".gguf") else {
            continue;
        };
        models.push((stem.to_string(), path));
    }

    for (stem, path) in &models {
        let stem = stem.as_str();
        let cat = by_stem.get(stem).copied();

        ini.push_str(&format!("[{}]\n", stem));
        ini.push_str(&format!("model = {}\n", path.display()));
        // `--jinja`: apply the GGUF's embedded chat template. Required for
        // tool calling and for templates that otherwise emit empty output.
        // Catalog says so for every chat model; default on when unmatched.
        let jinja = cat.map(|c| c.serving.jinja_required).unwrap_or(true);
        ini.push_str(&format!("jinja = {}\n", if jinja { 1 } else { 0 }));
        ini.push_str(&format!("n-gpu-layers = {}\n", n_gpu_layers));
        ini.push_str(&format!("ctx-size = {}\n", ctx_size));
        ini.push_str(&format!("batch-size = {}\n", batch_size));
        ini.push_str(&format!("ubatch-size = {}\n", ubatch_size));
        ini.push_str(&format!("threads = {}\n", threads));
        ini.push_str("parallel = 1\n");

        // Per-model sampler defaults from the catalog's serving profile.
        // These are the model author's recommended values (Unsloth's
        // per-family guidance) and apply unless the request overrides them.
        if let Some(c) = cat {
            let s = &c.serving;
            ini.push_str(&format!("temp = {}\n", s.temperature));
            ini.push_str(&format!("top-p = {}\n", s.top_p));
            if s.top_k > 0 {
                ini.push_str(&format!("top-k = {}\n", s.top_k));
            }
            if s.min_p > 0.0 {
                ini.push_str(&format!("min-p = {}\n", s.min_p));
            }

            // Speculative decoding. Built-in MTP heads (Qwen 3.5/3.6, GLM,
            // DeepSeek) load via `--spec-type draft-mtp` with no separate
            // drafter file. Classical two-model speculation uses
            // `--spec-type draft` plus a `--spec-draft-model` — only wire
            // that when the paired drafter GGUF is actually present on disk.
            match c.mtp_kind {
                MtpKind::DraftMtp => {
                    ini.push_str("spec-type = draft-mtp\n");
                    if let Some(n) = c.mtp_default_draft_n {
                        ini.push_str(&format!("spec-draft-n-max = {}\n", n));
                    }
                }
                MtpKind::Generic => {
                    if let Some(drafter_path) =
                        c.drafter_id.as_ref().and_then(|d| {
                            resolve_drafter_path(d, &catalog, models_dir)
                        })
                    {
                        ini.push_str("spec-type = draft\n");
                        ini.push_str(&format!(
                            "spec-draft-model = {}\n",
                            drafter_path.display()
                        ));
                        if let Some(n) = c.mtp_default_draft_n {
                            ini.push_str(&format!("spec-draft-n-max = {}\n", n));
                        }
                    }
                }
                MtpKind::None => {}
            }

            // MoE CPU-offload: for Mixture-of-Experts models on memory-
            // constrained hosts, offload expert tensors to CPU so the GPU
            // holds only the dense path + active experts. `--n-cpu-moe N`
            // counts from the top layers down; the hardware profile picks N
            // from the host's VRAM headroom (0 = keep all experts on GPU).
            if c.moe.is_some() {
                let n_cpu_moe = profile.n_cpu_moe();
                if n_cpu_moe > 0 {
                    ini.push_str(&format!("n-cpu-moe = {}\n", n_cpu_moe));
                }
            }

            // Multimodal projector (mmproj): vision-capable models load a
            // separate projector via `--mmproj`. The downloader stores it
            // flat as `<models_dir>/<id>.mmproj.gguf`; only emit the flag
            // when the entry declares a projector AND the file is actually
            // on disk, so a text-only fallback degrades gracefully.
            if c.mmproj.is_some() {
                let mmproj_path =
                    models_dir.join(format!("{}.mmproj.gguf", c.id));
                if mmproj_path.exists() {
                    ini.push_str(&format!("mmproj = {}\n", mmproj_path.display()));
                }
            }
        }

        // Per-model template override when the stem matches a known-
        // broken prefix. The first match wins so longer / more
        // specific prefixes should appear before shorter ones in
        // the TEMPLATE_OVERRIDES list.
        for (prefix, template_file) in TEMPLATE_OVERRIDES {
            if stem.starts_with(prefix) {
                let tpl_path = templates_dir.join(template_file);
                if tpl_path.exists() {
                    ini.push_str(&format!(
                        "chat-template-file = {}\n",
                        tpl_path.display()
                    ));
                    info!(
                        "Applying chat-template override for {}: {}",
                        stem,
                        tpl_path.display()
                    );
                }
                break;
            }
        }
        ini.push('\n');
    }

    std::fs::write(&preset_path, &ini)
        .map_err(|e| format!("failed to write preset file: {}", e))?;
    Ok(preset_path)
}

/// Resolve a classical speculative-decoding drafter (`MtpKind::Generic`)
/// to an on-disk GGUF path. Returns `None` unless the drafter's GGUF has
/// actually been downloaded into `models_dir` — llama.cpp can only pair a
/// drafter that is present locally, so an absent drafter silently disables
/// speculation rather than failing the load.
fn resolve_drafter_path(
    drafter_id: &str,
    catalog: &[tenzro_model::catalog::HfModelEntry],
    models_dir: &std::path::Path,
) -> Option<PathBuf> {
    let drafter = catalog.iter().find(|e| e.id == drafter_id)?;
    let file = drafter.hf_filename.rsplit('/').next()?;
    let path = models_dir.join(file);
    path.exists().then_some(path)
}

/// Path to the vendored chat-template directory. In a bundled app
/// this lives next to the main executable (where `externalBin`
/// drops the sidecar binary). In dev mode it's the source tree.
fn templates_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("templates");
            if bundled.exists() {
                return bundled;
            }
        }
    }
    PathBuf::from("src-tauri/templates")
}

async fn wait_for_health(base_url: &str, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    let url = format!("{}/health", base_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            // llama-server returns 200 once accepting requests; 503
            // while a model is loading. Either status proves the
            // socket is up.
            let s = resp.status().as_u16();
            if s == 200 || s == 503 {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    false
}

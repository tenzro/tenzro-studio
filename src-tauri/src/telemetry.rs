//! Opt-in crash telemetry — DSN baked at build time via
//! `IPNOPS_SENTRY_DSN`; runtime opt-in via the
//! `~/.tenzro/inference/telemetry.enabled` sentinel file. A fresh
//! install sends nothing without explicit user consent.

/// DSN baked at build time. Distribution builds set this via
/// `IPNOPS_SENTRY_DSN=<dsn> cargo tauri build`; dev / unset = `None`,
/// in which case `init` returns `None` and the app sends no telemetry
/// regardless of the user's opt-in state.
pub const SENTRY_DSN: Option<&str> = option_env!("IPNOPS_SENTRY_DSN");

/// Path to the user-consent sentinel. Existence (any content) means
/// the user opted in to telemetry; absence means they have not.
fn sentinel_path() -> Option<std::path::PathBuf> {
    Some(dirs::home_dir()?.join(".tenzro/inference/telemetry.enabled"))
}

/// Return true iff the user has explicitly opted in to telemetry by
/// creating ~/.tenzro/inference/telemetry.enabled.
pub fn user_opt_in() -> bool {
    sentinel_path().map(|p| p.exists()).unwrap_or(false)
}

/// Initialise Sentry crash + panic reporting iff (a) a DSN was baked
/// in at build time and (b) the user opted in via the sentinel file.
/// No-op (returns `None`) otherwise — the app sends nothing.
pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = SENTRY_DSN?;
    if !user_opt_in() {
        return None;
    }
    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: sentry::release_name!(),
            // Don't ship request body / args — never want to leak
            // chat content or user prompts.
            send_default_pii: false,
            // Conservative sample: capture all errors + panics, no
            // performance traces (perf traces are noisy + costly +
            // unhelpful for a desktop app's crash diagnosis).
            traces_sample_rate: 0.0,
            ..Default::default()
        },
    ));
    Some(guard)
}

/// UI command — read the current telemetry opt-in state. Returns
/// `{enabled, available}` where `available` is true iff a DSN was
/// baked into this build.
#[tauri::command]
pub fn telemetry_state() -> serde_json::Value {
    serde_json::json!({
        "enabled": user_opt_in(),
        "available": SENTRY_DSN.is_some(),
    })
}

/// UI command — set the telemetry opt-in state. Creates or removes
/// `~/.tenzro/inference/telemetry.enabled`. Takes effect on the next
/// app start (we don't dynamically init/teardown Sentry mid-run).
#[tauri::command]
pub fn set_telemetry_enabled(enabled: bool) -> Result<(), String> {
    let path = sentinel_path()
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    if enabled {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create telemetry dir: {}", e))?;
        }
        std::fs::write(&path, b"1\n")
            .map_err(|e| format!("could not write telemetry sentinel: {}", e))?;
    } else if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("could not remove telemetry sentinel: {}", e))?;
    }
    Ok(())
}

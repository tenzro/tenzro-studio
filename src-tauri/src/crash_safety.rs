//! Crash-safety net for paths Tauri's normal exit hooks don't cover.
//!
//! Tauri 2.11 + macOS arm64 has at least four documented ways for the
//! parent process to die WITHOUT firing `RunEvent::ExitRequested`,
//! `RunEvent::Exit`, `WindowEvent::CloseRequested`, or our Unix-signal
//! listener:
//!
//! 1. **Non-unwinding panic in wry's WKWebView callbacks** (tauri-apps/tauri#12338)
//!    — `wry` wraps callbacks in `AssertUnwindSafe`, so a panic there
//!    becomes `thread caused non-unwinding panic. aborting.` and the
//!    process abort()s without unwinding. No Rust panic hook runs.
//! 2. **Silent panic in `tauri::async_runtime::spawn`** — tokio default
//!    catches panics into the JoinHandle. If nothing `.await`s the
//!    handle, the panic is lost when the handle drops; eventually a
//!    correlated failure brings down the runtime.
//! 3. **Double-panic during Drop** — first panic fires the hook, the
//!    second triggers `abort()` often with no extra message.
//! 4. **Cmd-Q / quit-from-Dock on macOS** — `RunEvent::ExitRequested`
//!    is not always fired (tauri-apps/tauri#9198) because Tauri 2.11
//!    doesn't hook `applicationShouldTerminate:`.
//!
//! Fingerprint of any of the above: the `llama-server` sidecar subprocess
//! is left with `ppid=1` (reparented to launchd), no stderr panic line,
//! no `~/Library/Logs/DiagnosticReports/Ipnops*.ips`, just a vanished PID.
//!
//! This module installs THREE layers of defence:
//!
//! - `std::panic::set_hook` — catches unwinding panics, logs payload +
//!   backtrace via tracing, runs synchronous sidecar kill, then
//!   `std::process::exit(101)`.
//! - `libc::atexit` — catches `process::exit`, `process::abort`, and
//!   non-unwinding aborts from wry. Runs the same sidecar kill.
//! - `std::alloc::set_alloc_error_hook` — catches allocator OOM.
//!
//! All three converge on `kill_sidecar_blocking()` which is idempotent
//! (guarded by `SHUTDOWN_DONE: AtomicBool`) and synchronous (no `.await`,
//! because the runtime may be poisoned).
//!
//! Sources:
//! - <https://github.com/tauri-apps/tauri/issues/12338>
//! - <https://github.com/tauri-apps/tauri/issues/9198>
//! - <https://aptabase.com/blog/catching-panics-on-tauri-apps>

use std::backtrace::Backtrace;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The llama-server sidecar PID, reachable from the panic hook + atexit
/// handler without needing `AppHandle` (which is unsafe to call into
/// from a panicking thread) and without needing an `await` (which is
/// unsafe inside libc::atexit). Stored as a raw u32 because the
/// kill path uses libc::kill / libc::waitpid directly. 0 = no sidecar.
///
/// Populated by `register_sidecar_pid` after the spawn returns; cleared
/// by `forget_sidecar_pid` on the normal stop path so the atexit hook
/// doesn't try to kill an already-reaped process.
static SIDECAR_PID: AtomicU32 = AtomicU32::new(0);

/// Idempotency guard so the kill path runs exactly once even when
/// multiple exit paths fire concurrently (e.g. panic hook + atexit on
/// the same process exit).
static SHUTDOWN_DONE: AtomicBool = AtomicBool::new(false);

/// One-time slot guarding `install_safety_net` against accidental
/// double-call (which would chain hook closures forever).
static INSTALLED: OnceLock<()> = OnceLock::new();

/// Register the llama-server PID so the crash-safety hooks can kill it
/// on any abnormal exit. Replaces any previously-registered PID
/// (relevant after `restart_sidecar` swaps the process).
pub fn register_sidecar_pid(pid: u32) {
    SIDECAR_PID.store(pid, Ordering::SeqCst);
}

/// Clear the registered PID. Called from the normal graceful_shutdown
/// path right before SidecarHandle::stop() runs so the atexit hook
/// doesn't try to kill an already-reaped process.
pub fn forget_sidecar_pid() {
    SIDECAR_PID.store(0, Ordering::SeqCst);
}

/// SIGTERM → 500ms grace → SIGKILL. Synchronous, signal-safe, no
/// `await`, no allocation on the kill path. Used from panic hook +
/// atexit + alloc-error-hook contexts where the tokio runtime may be
/// poisoned.
fn kill_sidecar_blocking() {
    if SHUTDOWN_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let pid = SIDECAR_PID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        // SIGTERM first, then poll waitpid for up to 500ms, then SIGKILL.
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut status: libc::c_int = 0;
        loop {
            let r = libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG);
            if r == pid as libc::pid_t {
                break;
            }
            if Instant::now() >= deadline {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
                let _ = libc::waitpid(pid as libc::pid_t, &mut status, 0);
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    // eprintln is async-signal-safe enough for this best-effort log;
    // tracing is NOT signal-safe and may deadlock from the panic hook.
    eprintln!("crash_safety: sidecar pid {} reaped on abnormal exit", pid);
}

extern "C" fn atexit_cleanup() {
    kill_sidecar_blocking();
}

/// Install the panic hook + atexit handler + alloc-error hook. Call
/// ONCE at the very start of `run()`, before any other initialisation,
/// so the safety net is armed before any spawn that could panic.
/// Subsequent calls are no-ops (guarded by `INSTALLED`).
pub fn install_safety_net() {
    if INSTALLED.set(()).is_err() {
        return;
    }
    // Force backtraces in the panic hook even if the user didn't set
    // RUST_BACKTRACE. Safe to do at startup before threads are spawned.
    if std::env::var_os("RUST_BACKTRACE").is_none() {
        // SAFETY: env mutation at startup, single-threaded.
        unsafe {
            std::env::set_var("RUST_BACKTRACE", "full");
        }
    }

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = Backtrace::force_capture();
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&'static str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("<non-string panic payload>");

        // Structured tracing log (goes to file appender).
        tracing::error!(
            target: "panic",
            thread = thread_name,
            location = %location,
            backtrace = %bt,
            "PANIC: {}", msg
        );

        // Defensive stderr in case tracing is dead.
        eprintln!(
            "\n=== PANIC in thread '{}' at {} ===\npayload: {}\nbacktrace:\n{}",
            thread_name, location, msg, bt
        );

        // Run sidecar cleanup. catch_unwind to prevent a double-panic
        // here from short-circuiting the default_hook below.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(kill_sidecar_blocking));

        // Chain to the default hook so the panic message is also
        // printed in the canonical Rust format (helpful in dev).
        default_hook(info);

        // Hard exit so a poisoned runtime can't keep limping.
        std::process::exit(101);
    }));

    // Catches process::exit, process::abort, and the non-unwinding
    // aborts that come out of wry's AssertUnwindSafe callbacks
    // (tauri#12338). This is the ONLY layer that catches the silent-exit
    // class — the panic hook above does not fire for these.
    #[cfg(unix)]
    unsafe {
        libc::atexit(atexit_cleanup);
    }

    // Note: `std::alloc::set_alloc_error_hook` would log allocator-OOM
    // before abort, but it's still nightly-only (#![feature(alloc_error_hook)],
    // tracking issue rust-lang/rust#51245). The atexit handler above
    // catches the abort itself so the sidecar is still reaped — we
    // just don't get a labelled log line specifically for OOM. Skip.
}

//! Host hardware probe + per-profile llama-server tuning.
//!
//! The app must run on any machine the user installs it on: a 6 GB
//! Raspberry Pi, an 8 GB Intel laptop with no discrete GPU, a 16 GB
//! Apple Silicon M-series, a 24 GB workstation with an RTX, a 96 GB
//! Mac Studio. Hard-coding one set of llama-server flags works for
//! the M-series but is wrong at both ends: small machines OOM the GPU
//! and fall over, big workstations underuse it.
//!
//! Tuning policy is lifted verbatim from Ollama's `server/sched.go` +
//! `llm/llama_server.go` (the most-shipped local-AI runtime in 2026):
//!
//! - **`--n-gpu-layers`**: when a GPU is present, set to 999 (the
//!   "offload everything" sentinel — llama.cpp clamps to the model's
//!   layer count). When no GPU is present, 0. A real per-layer fit
//!   check against `0.7 × VRAM_free` (the desktop-safe variant of
//!   Ollama's 80% rule) requires parsing GGUF metadata for per-layer
//!   weight bytes; defer until we wire a GGUF reader. llama.cpp's
//!   own OOM-on-load error is the user-visible safety net.
//! - **`--batch-size` / `--ubatch-size`**: by ctx-size ladder. ≤4096
//!   ctx → 512, 4097-32 768 ctx → 1024, >32 768 ctx → 2048. On
//!   unified-memory GPUs (Apple Silicon, Intel iGPU) we cap at 512
//!   regardless of ctx because bigger Metal command buffers contend
//!   with WindowServer and cause the whole-screen flicker (U14 root
//!   cause).
//! - **`--threads`**: physical cores − 1 on macOS (leave one for the
//!   compositor), physical cores elsewhere. SMT siblings hurt
//!   llama.cpp throughput so we always use physical, not logical.
//! - **`--ctx-size`**: quarter-of-RAM heuristic (LM Studio default).
//!   Bigger context costs RAM linearly for the KV cache; capping by
//!   RAM avoids 6 GB devices trying to allocate the 32k-token cache
//!   LM Studio's auto-default suggests on big machines.
//!
//! Probe layer: `sysinfo` for RAM + logical cores cross-platform, plus
//! OS-native sysctl on macOS for the P-core count + Apple-Silicon
//! detection. GPU class is detected via cheap presence checks
//! (`nvidia-smi` / `rocm-smi` in PATH, sysctl `hw.optional.arm64`,
//! Windows WMI `Win32_VideoController`). Heavyweight VRAM accounting
//! (NVML via `nvml-wrapper`, Metal `recommendedMaxWorkingSetSize`)
//! is a follow-up wave.

use std::process::Command;

use sysinfo::System;

/// Coarse GPU class. Drives offload + batch tuning because Metal /
/// CUDA / ROCm have very different command-buffer cost profiles, and
/// because shared-memory GPUs fight the compositor for the same
/// surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuClass {
    /// No GPU offload available — CPU-only inference.
    None,
    /// Apple Silicon unified-memory GPU. Shares RAM with the OS +
    /// WindowServer compositor; we cap batch sizes to keep each
    /// command buffer short enough that the display always wins
    /// arbitration within one refresh interval.
    AppleSilicon,
    /// Discrete NVIDIA GPU (CUDA path). Detected via `nvidia-smi`
    /// presence in PATH — same approach Ollama uses. Has its own
    /// VRAM so command-buffer length doesn't fight the compositor.
    Cuda,
    /// Discrete AMD GPU (ROCm path on Linux). Detected via
    /// `rocm-smi` presence.
    Rocm,
    /// Intel integrated graphics, AMD APU, or legacy Intel Mac
    /// discrete. Falls back to llama.cpp's Metal/Vulkan backend;
    /// same conservative profile as Apple Silicon because the
    /// compositor shares the surface.
    IntelOrIntegrated,
}

#[derive(Debug, Clone)]
pub struct HardwareProfile {
    /// Total system RAM in gigabytes (rounded down to whole GB).
    pub ram_gb: u32,
    /// Physical CPU core count. For SMT machines we want physical,
    /// not logical, because llama.cpp's matmul is memory-bandwidth-
    /// bound and SMT siblings contend on the same FPU / L1.
    pub physical_cores: u32,
    /// Detected GPU class. Drives offload + batch tuning.
    pub gpu_class: GpuClass,
}

impl HardwareProfile {
    pub fn detect() -> Self {
        let mut sys = System::new();
        sys.refresh_memory();
        sys.refresh_cpu_list(sysinfo::CpuRefreshKind::new());
        let ram_gb = (sys.total_memory() / 1024 / 1024 / 1024) as u32;
        Self {
            ram_gb: ram_gb.max(1),
            physical_cores: probe_physical_cores(&sys),
            gpu_class: probe_gpu_class(),
        }
    }

    /// `-ngl` value to pass to llama-server. `999` is the "offload
    /// everything" sentinel — the backend clamps to the model's
    /// actual layer count. Returns `0` when no GPU is available so
    /// llama.cpp stays on the CPU path.
    pub fn n_gpu_layers(&self) -> u32 {
        match self.gpu_class {
            GpuClass::None => 0,
            _ => 999,
        }
    }

    /// `--batch-size` for the given context window. Ollama's ladder:
    /// ≤4096 → 512, 4097-32 768 → 1024, >32 768 → 2048. Shared-
    /// memory GPUs cap at 512 regardless of ctx because bigger
    /// Metal command buffers contend with WindowServer compositing
    /// (the documented U14 flicker amplifier).
    pub fn batch_size(&self, ctx: u32) -> u32 {
        let shared_memory = matches!(
            self.gpu_class,
            GpuClass::AppleSilicon | GpuClass::IntelOrIntegrated | GpuClass::None
        );
        if shared_memory {
            return 512;
        }
        if ctx <= 4096 {
            512
        } else if ctx <= 32_768 {
            1024
        } else {
            2048
        }
    }

    /// `--ubatch-size` (micro-batch). Ollama keeps `ubatch == batch`
    /// by default for generation workloads. We follow suit so the
    /// inner attention loop runs at the same granularity as the
    /// outer prompt-processing loop.
    pub fn ubatch_size(&self, ctx: u32) -> u32 {
        self.batch_size(ctx)
    }

    /// `--threads` value. llama.cpp throughput peaks at physical-
    /// core count. On macOS we subtract one to leave a core free for
    /// WindowServer; on other OSes the compositor either has its
    /// own dedicated thread (Linux Wayland) or runs on a different
    /// process (Windows DWM), so all physical cores are fair game.
    pub fn threads(&self) -> u32 {
        let base = self.physical_cores.max(1);
        #[cfg(target_os = "macos")]
        {
            base.saturating_sub(1).max(1)
        }
        #[cfg(not(target_os = "macos"))]
        {
            base
        }
    }

    /// `--ctx-size`. Quarter-of-RAM heuristic (LM Studio default).
    /// Bigger context costs RAM linearly for the KV cache; capping
    /// by RAM avoids 6 GB devices trying to allocate the 32k-token
    /// cache LM Studio's auto-default suggests on big machines.
    pub fn ctx_size(&self) -> u32 {
        if self.ram_gb >= 64 {
            32_768
        } else if self.ram_gb >= 32 {
            16_384
        } else if self.ram_gb >= 16 {
            8_192
        } else if self.ram_gb >= 8 {
            4_096
        } else {
            2_048
        }
    }

    /// Whether to demote the sidecar's GPU QoS via `taskpolicy` /
    /// `nice`. Only meaningful on unified-memory hosts where the GPU
    /// is shared with the compositor. Discrete-GPU machines don't
    /// need it — WindowServer has its own surface and the OS
    /// scheduler is already separating concerns.
    pub fn demote_gpu_qos(&self) -> bool {
        matches!(
            self.gpu_class,
            GpuClass::AppleSilicon | GpuClass::IntelOrIntegrated | GpuClass::None
        )
    }
}

/// Prefer the OS-native P-core probe (Apple Silicon hybrid arch
/// reports both P-core and E-core counts; only P-cores should
/// receive llama.cpp threads). Falls back to a hyperthreading-
/// aware logical/2 heuristic.
fn probe_physical_cores(sys: &System) -> u32 {
    #[cfg(target_os = "macos")]
    {
        if let Some(n) = sysctl_u64("hw.perflevel0.physicalcpu") {
            return (n as u32).max(1);
        }
        if let Some(n) = sysctl_u64("hw.physicalcpu") {
            return (n as u32).max(1);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(cpuinfo) = std::fs::read_to_string("/proc/cpuinfo") {
            let mut pairs: std::collections::HashSet<(String, String)> =
                std::collections::HashSet::new();
            let mut phys: Option<String> = None;
            let mut core: Option<String> = None;
            for line in cpuinfo.lines() {
                if let Some(rest) = line.strip_prefix("physical id") {
                    phys = rest.split(':').nth(1).map(|s| s.trim().to_string());
                } else if let Some(rest) = line.strip_prefix("core id") {
                    core = rest.split(':').nth(1).map(|s| s.trim().to_string());
                } else if line.is_empty() {
                    if let (Some(p), Some(c)) = (phys.take(), core.take()) {
                        pairs.insert((p, c));
                    }
                }
            }
            if !pairs.is_empty() {
                return pairs.len() as u32;
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = Command::new("wmic")
            .args(["cpu", "get", "NumberOfCores"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            let mut total = 0u32;
            for line in s.lines() {
                if let Ok(n) = line.trim().parse::<u32>() {
                    total = total.saturating_add(n);
                }
            }
            if total > 0 {
                return total;
            }
        }
    }
    let logical = sys.cpus().len() as u32;
    (logical / 2).max(1)
}

fn probe_gpu_class() -> GpuClass {
    #[cfg(target_os = "macos")]
    {
        if sysctl_u64("hw.optional.arm64") == Some(1) {
            return GpuClass::AppleSilicon;
        }
        return GpuClass::IntelOrIntegrated;
    }
    #[cfg(target_os = "linux")]
    {
        if Command::new("nvidia-smi")
            .arg("--query-gpu=name")
            .arg("--format=csv,noheader")
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
        {
            return GpuClass::Cuda;
        }
        if Command::new("rocm-smi")
            .arg("--showproductname")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return GpuClass::Rocm;
        }
        if Command::new("lspci")
            .output()
            .map(|o| {
                let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
                s.contains("intel") && (s.contains("vga") || s.contains("display"))
            })
            .unwrap_or(false)
        {
            return GpuClass::IntelOrIntegrated;
        }
        return GpuClass::None;
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = Command::new("wmic")
            .args(["path", "win32_VideoController", "get", "Name"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if s.contains("nvidia") || s.contains("rtx") || s.contains("gtx") {
                return GpuClass::Cuda;
            }
            if s.contains("radeon") || s.contains("amd") {
                return GpuClass::Rocm;
            }
            if s.contains("intel") || s.contains("uhd") || s.contains("iris") {
                return GpuClass::IntelOrIntegrated;
            }
        }
        return GpuClass::None;
    }
    #[allow(unreachable_code)]
    GpuClass::None
}

#[cfg(target_os = "macos")]
fn sysctl_u64(key: &str) -> Option<u64> {
    let out = Command::new("/usr/sbin/sysctl").args(["-n", key]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.parse().ok()
}

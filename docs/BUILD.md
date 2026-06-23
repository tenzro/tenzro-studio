# Building Tenzro Studio from source

Per-platform compile guide. Tenzro Studio is a **GUI** Tauri v2 app (a WebView
window + an embedded `tenzro-node`); there is no headless build target — see
[Headless?](#headless) at the bottom.

Each desktop installer must be built **on its own native OS**. Cross-compiling
the bundles (and especially the `llama-server` sidecar) from one platform to
another is not supported here.

---

## Common prerequisites (all platforms)

- **Node.js 20+** and npm
- **Rust** stable (`rustup`), with the host target installed by default
- **CMake 3.14+** and a C/C++ toolchain (for the `llama-server` sidecar build)
- The Tauri platform prerequisites for your OS (links below)

```bash
npm install            # JS deps + the Tauri CLI (@tauri-apps/cli)
```

The Tauri CLI is a project devDependency, invoked through npm — there is no
global install to manage:

```bash
npm run tauri --help   # the full Tauri CLI
npm run tauri dev      # hot-reload dev build (GUI)
npm run tauri build    # produce the platform installers
```

> **The `tenzro-node` dependency.** A fresh clone does not yet build from
> crates.io (`tenzro-node 0.1` is unpublished). If you are also working in the
> `tenzro-network` repo, add a local `[patch.crates-io]` entry per
> [CONTRIBUTING.md](../CONTRIBUTING.md). This is the same on every platform.

## The sidecar comes first

`npm run tauri build` bundles `src-tauri/binaries/llama-server-<target-triple>`
as a Tauri `externalBin`. That file must exist **for the host you are building
on**, or the bundle step fails. It must also be a **self-contained static
binary** — the official llama.cpp releases are dynamically linked against
`libggml*/libllama*` companion libraries that a single-file sidecar can't carry,
so we build it statically:

```bash
src-tauri/scripts/build-sidecar.sh          # builds + installs for the host triple
src-tauri/scripts/build-sidecar.sh b9765    # pin a specific llama.cpp release tag
```

Run that **once per platform** before `npm run tauri build`. It writes the
correctly-named file into `src-tauri/binaries/` and verifies the result has no
ggml/llama dynamic links.

---

## macOS

Target triples: `aarch64-apple-darwin` (Apple Silicon), `x86_64-apple-darwin` (Intel).
Installer outputs: `.app`, `.dmg`.

**Prerequisites** ([Tauri macOS](https://tauri.app/start/prerequisites/#macos)):

```bash
xcode-select --install        # Clang + Metal toolchain
brew install cmake node
# Rust:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Build:**

```bash
npm install
src-tauri/scripts/build-sidecar.sh    # static llama-server with Metal embedded
npm run tauri build
# bundles land in src-tauri/target/release/bundle/{macos,dmg}/
```

**Signing / notarization (distribution only).** Codesigning is wired through
env vars — see the table in [README.md](../README.md#release--distribution).
The Secure-Enclave wallet-persistence re-sign is a separate, optional step
documented in `src-tauri/scripts/enable-wallet-persistence.sh`.

> Apple Silicon and Intel are **separate builds** — run the whole flow on each
> arch (or use `--target` on a machine with both toolchains). A universal binary
> is not produced automatically.

---

## Linux

Target triples: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`.
Installer outputs: `.deb`, `.rpm`, `.AppImage`.

**Prerequisites** ([Tauri Linux](https://tauri.app/start/prerequisites/#linux)).
On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  cmake
# Node 20+ (nodesource or your distro), then Rust via rustup as above.
```

Fedora/RHEL equivalents: `webkit2gtk4.1-devel`, `openssl-devel`,
`libappindicator-gtk3-devel`, `librsvg2-devel`, `cmake`, plus
`@development-tools`.

**Build:**

```bash
npm install
src-tauri/scripts/build-sidecar.sh    # static CPU llama-server
npm run tauri build
# bundles land in src-tauri/target/release/bundle/{deb,rpm,appimage}/
```

Notes:
- Tauri auto-adds the runtime deps (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, and
  `libappindicator3-1` for the tray) to the generated `.deb`/`.rpm` — no manual
  `bundle.linux.deb.depends` is required for the current feature set.
- The AppImage bundles gstreamer (`appimage.bundleMediaFramework: true`) so
  media works without host codecs.
- The sidecar is built **CPU-only** here for portability (no CUDA/Vulkan driver
  assumptions on the user's machine); `--n-gpu-layers` degrades to CPU.

---

## Windows

Target triple: `x86_64-pc-windows-msvc`.
Installer outputs: `.msi` (WiX) and `.exe` (NSIS).

**Prerequisites** ([Tauri Windows](https://tauri.app/start/prerequisites/#windows)):

- **Visual Studio Build Tools** with the *Desktop development with C++* workload
  (MSVC + Windows SDK + CMake).
- **WebView2 Runtime** — preinstalled on Windows 10 (April 2018+) and Windows 11.
  The installer embeds the bootstrapper (`webviewInstallMode: embedBootstrapper`)
  so older machines self-provision it without a network download.
- **Node 20+** and **Rust** (`x86_64-pc-windows-msvc` toolchain, the rustup default).

**Build** (run the sidecar script from **Git Bash** or **MSYS2** — it is a bash
script; the `tauri build` itself runs from any shell):

```bash
npm install
# In Git Bash / MSYS2:
src-tauri/scripts/build-sidecar.sh    # produces llama-server-...-msvc.exe
# Then, from any shell:
npm run tauri build
# bundles land in src-tauri\target\release\bundle\{msi,nsis}\
```

Signing uses `bundle.windows.certificateThumbprint` / `signCommand` — out of
scope for a dev build; unsigned installers build fine.

---

## Headless?

There isn't a headless mode. `src-tauri/src/main.rs` calls
`tenzro_studio::run()` unconditionally, which always creates the GUI window —
there are no CLI subcommands or `--headless` flag. The **node** that Studio
embeds (`tenzro-node`) does have its own headless `main`, but that is a separate
binary in the `tenzro-network` repo, not something this app exposes. If you want
a node without the GUI, run `tenzro-node` directly from that repo.

# Ipnops Edge

Run, serve, and contribute AI to the Tenzro Network — from one bundled installer.

Ipnops Edge embeds a full Tenzro node in a desktop app so any home user can:

- Download AI models from the Tenzro model registry (LLMs, mixture-of-experts, vision, audio).
- Run them locally with GPU acceleration (Metal, CUDA, ROCm, Vulkan, CPU).
- Serve them to the Tenzro Network as a provider and earn from inference.
- Contribute compute to decentralized training runs (Tenzro Train).
- Optionally graduate to a validator with on-chain stake.

The app ships every dependency — embedded node, llama.cpp runtime, Python trainer venv — in a single installer. No `cargo`, no `pip`, no manual setup.

## Status

Pre-alpha. The repository structure is in place; user-facing pages and packaging are being assembled. **A fresh clone does not yet build from source** — the embedded `tenzro-node` dependency is not on crates.io yet (its own upstream deps need release coordination, tracked in tenzro-network). See [CONTRIBUTING.md](CONTRIBUTING.md) for the per-machine `[patch.crates-io]` workaround.

## Build from source

Requirements: Node.js 20+, Rust stable, platform Tauri prerequisites
([macOS](https://tauri.app/start/prerequisites/#macos),
[Windows](https://tauri.app/start/prerequisites/#windows),
[Linux](https://tauri.app/start/prerequisites/#linux)).

```bash
npm install
npm run tauri dev    # development with hot reload
npm run tauri build  # produce platform bundles (.dmg / .msi / .AppImage)
```

The embedded node currently resolves `tenzro-node` from crates.io. Until
`tenzro-node 0.1` is published, contributors hacking on both this repo and
tenzro-network at once can add a
local `[patch.crates-io]` entry to their workspace root — see CONTRIBUTING.md.

## Release / distribution

Production release builds wire three optional env vars at `cargo tauri build`
time. They are inert when unset (the dev build sends nothing, ships
unsigned, and does not phone home), so contributors don't need any of them:

| Env var | Effect | Where to get it |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | Codesigns the bundle so macOS Gatekeeper opens it without a "from an unidentified developer" prompt. Required for distribution outside the Mac App Store. | Tenzro Labs cert in the Apple Developer account. **Never hardcode** — env-only. |
| `IPNOPS_SENTRY_DSN` | Bakes a Sentry DSN into the binary. Even with a DSN, the app sends NOTHING unless the user opts in by creating `~/.tenzro/inference/telemetry.enabled` (the UI exposes a toggle). | Sentry project for `ipnops-edge`. |
| `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signs the updater payload (`latest.json` + the `.app.tar.gz` / `.msi` artefact) so the installed app trusts the update. Generate with `cargo tauri signer generate`; the matching `pubkey` lives in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. | Generated once per release channel; keep the private key in a secret manager. |

The hardened-runtime entitlements (`src-tauri/entitlements.plist`) cover the
JIT + dyld + library-validation needs of the bundled `llama-server` sidecar
under codesign. The updater endpoint is
`https://ipnops.xyz/edge/updates/{{target}}/{{arch}}/{{current_version}}`
and expects a Tauri-format `latest.json`.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).

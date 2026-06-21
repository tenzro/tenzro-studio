#!/usr/bin/env bash
#
# Build the llama-server sidecar from the vendored llama.cpp sources
# (in the tenzro-network repo) and copy it into the Tauri bundle path
# with the right per-target-triple suffix.
#
# Run from the repo root before `npm run tauri build`.

set -euo pipefail

DEFAULT_LLAMA_CPP_DIR="$HOME/AI/tenzronetwork/vendor/llama-cpp-rs/llama-cpp-sys-2/llama.cpp"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$DEFAULT_LLAMA_CPP_DIR}"

if [ ! -d "$LLAMA_CPP_DIR" ]; then
  echo "error: llama.cpp source not found at $LLAMA_CPP_DIR"
  echo "Set LLAMA_CPP_DIR to point at vendor/llama-cpp-rs/llama-cpp-sys-2/llama.cpp"
  exit 1
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
# LLAMA_OPENSSL defaults ON, which links Homebrew's libssl/libcrypto.
# Those dylibs are signed under Homebrew's team, so dyld's library
# validation refuses to load them into our Developer-ID-signed,
# hardened-runtime app ("different Team IDs") and the sidecar won't
# launch from the bundle. The sidecar only ever serves 127.0.0.1 over
# plain HTTP, so HTTPS support is unnecessary — turn it OFF to drop the
# dependency entirely (cleaner than bundling + re-signing the dylibs).
CMAKE_FLAGS=(-DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF)
case "$OS" in
  Darwin)
    CMAKE_FLAGS+=(-DGGML_METAL=ON)
    if [ "$ARCH" = "arm64" ]; then TRIPLE="aarch64-apple-darwin"; else TRIPLE="x86_64-apple-darwin"; fi
    ;;
  Linux)
    if command -v nvcc >/dev/null 2>&1; then
      CMAKE_FLAGS+=(-DGGML_CUDA=ON)
    fi
    if [ "$ARCH" = "aarch64" ]; then TRIPLE="aarch64-unknown-linux-gnu"; else TRIPLE="x86_64-unknown-linux-gnu"; fi
    ;;
  *)
    echo "error: unsupported OS for this script: $OS"
    exit 1
    ;;
esac

BUILD_DIR="$LLAMA_CPP_DIR/build-server"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo "Configuring (Release, ${CMAKE_FLAGS[*]})…"
cmake .. -DCMAKE_BUILD_TYPE=Release "${CMAKE_FLAGS[@]}" >/dev/null

echo "Building llama-server…"
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
cmake --build . --target llama-server --config Release -j "$JOBS"

# Resolve REPO_ROOT from an absolute path to the script. We `cd`'d into
# the build dir above, so a relative ${BASH_SOURCE[0]} would no longer
# resolve — capture it up front via an absolute dirname.
SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/src-tauri/binaries/llama-server-$TRIPLE"
mkdir -p "$(dirname "$DEST")"
cp "$BUILD_DIR/bin/llama-server" "$DEST"
chmod +x "$DEST"

echo "Staged $DEST"
ls -lh "$DEST"

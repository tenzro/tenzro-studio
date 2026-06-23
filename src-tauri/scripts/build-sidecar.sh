#!/usr/bin/env bash
# Build a SELF-CONTAINED (statically-linked) llama-server sidecar for the
# HOST platform and install it into src-tauri/binaries/ under the Tauri
# target-triple name that `externalBin` expects.
#
# WHY THIS SCRIPT EXISTS / why we don't just download a release:
#   Tauri's `externalBin` ships ONE file (renamed to plain `llama-server`)
#   next to the app binary; `resolve_sidecar_path()` in sidecar.rs looks for
#   exactly that single file and does NO companion-library wiring. But every
#   OFFICIAL llama.cpp release archive (macOS/Linux/Windows alike) is
#   DYNAMICALLY linked against a pile of libggml*/libllama*/libmtmd* shared
#   objects that must sit next to the exe on an rpath/PATH. Dropping the
#   release `llama-server` in alone => it launches then dies with a
#   missing-library error. The committed macOS sidecar is a custom STATIC
#   17 MB build for this reason. This script reproduces that for the host.
#
# Cross-compiling Windows/Linux binaries from macOS is out of scope here —
# build each target on its own native runner (or CI matrix) by running this
# script there. The triple is derived from the host, so the output filename
# is automatically correct for whichever platform you build on:
#   macOS arm64  -> llama-server-aarch64-apple-darwin
#   macOS x64    -> llama-server-x86_64-apple-darwin
#   Linux x64    -> llama-server-x86_64-unknown-linux-gnu
#   Linux arm64  -> llama-server-aarch64-unknown-linux-gnu
#   Windows x64  -> llama-server-x86_64-pc-windows-msvc.exe   (run under Git Bash / MSYS2)
#
# USAGE:
#   src-tauri/scripts/build-sidecar.sh [llama.cpp git ref]   # default: latest release tag
#
# REQUIREMENTS: git, cmake (>=3.14), a C/C++ toolchain, and on macOS the
# Xcode command-line tools (Metal). Linux GPU backends (CUDA/Vulkan) are
# intentionally NOT enabled — the sidecar is CPU+host-GPU(Metal) only so the
# single static binary stays portable across user machines. n-gpu-layers on
# non-Metal hosts degrades to CPU gracefully (llama.cpp ignores it).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"        # src-tauri/
BIN_DIR="$HERE/binaries"
REF="${1:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v git   >/dev/null || die "git not found"
command -v cmake >/dev/null || die "cmake not found (brew install cmake / apt install cmake)"

# --- Derive the Tauri target triple for the host ---------------------------
# Tauri names externalBin files `<name>-<rustc host triple>`. Use rustc if
# present (authoritative); otherwise fall back to uname-based detection.
TRIPLE=""
if command -v rustc >/dev/null; then
  TRIPLE="$(rustc -vV | awk -F': ' '/host/{print $2}')"
fi
if [[ -z "$TRIPLE" ]]; then
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$OS-$ARCH" in
    Darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
    Linux-x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
    *)             die "cannot derive target triple for $OS-$ARCH — install rustc, or run on a supported host" ;;
  esac
fi

EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac
OUT="$BIN_DIR/llama-server-$TRIPLE$EXT"
echo "Host target triple : $TRIPLE"
echo "Output sidecar     : $OUT"

# --- Fetch llama.cpp at the requested (or latest) ref ----------------------
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [[ -z "$REF" ]]; then
  REF="$(git ls-remote --tags --refs https://github.com/ggml-org/llama.cpp \
        | awk -F/ '{print $NF}' | grep -E '^b[0-9]+$' | sort -t b -k2 -n | tail -1)"
  [[ -n "$REF" ]] || die "could not resolve latest llama.cpp release tag"
fi
echo "llama.cpp ref      : $REF"
git clone --depth 1 --branch "$REF" https://github.com/ggml-org/llama.cpp "$WORK/llama.cpp" \
  || die "clone of llama.cpp@$REF failed"

# --- Configure a STATIC build ----------------------------------------------
# BUILD_SHARED_LIBS=OFF folds libggml/libllama/libmtmd into the server binary
# so the single file is self-contained — the whole point of this script.
# Metal is on for Apple Silicon (host GPU); Linux/Windows are CPU-only here to
# keep the binary portable (no CUDA/driver assumptions on the user's machine).
CMAKE_ARGS=(
  -S "$WORK/llama.cpp"
  -B "$WORK/build"
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_BUILD_SERVER=ON
  -DLLAMA_CURL=OFF
)
case "$TRIPLE" in
  *apple-darwin*) CMAKE_ARGS+=( -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON ) ;;
  *)              CMAKE_ARGS+=( -DGGML_NATIVE=OFF ) ;;  # portable CPU baseline
esac

echo "Configuring (static) ..."
cmake "${CMAKE_ARGS[@]}"
echo "Building llama-server ..."
cmake --build "$WORK/build" --target llama-server --config Release -j

# --- Locate the built server + install -------------------------------------
SERVER="$(find "$WORK/build" -type f -name "llama-server$EXT" -perm -u+x 2>/dev/null | head -1)"
[[ -z "$SERVER" ]] && SERVER="$(find "$WORK/build" -type f -name "llama-server$EXT" 2>/dev/null | head -1)"
[[ -n "$SERVER" ]] || die "build finished but llama-server$EXT not found under $WORK/build"

mkdir -p "$BIN_DIR"
cp "$SERVER" "$OUT"
chmod +x "$OUT"

# --- Verify self-containment (the failure this script exists to prevent) ---
echo "Verifying the binary is self-contained ..."
case "$TRIPLE" in
  *apple-darwin*)
    if otool -L "$OUT" | grep -qiE 'libggml|libllama|libmtmd'; then
      die "built binary still links ggml/llama dylibs — static link failed (check BUILD_SHARED_LIBS)"
    fi ;;
  *linux*)
    if command -v ldd >/dev/null && ldd "$OUT" 2>/dev/null | grep -qiE 'libggml|libllama|libmtmd'; then
      die "built binary still links ggml/llama .so — static link failed (check BUILD_SHARED_LIBS)"
    fi ;;
esac

SIZE="$(du -h "$OUT" | cut -f1)"
echo
echo "DONE. Installed self-contained sidecar ($SIZE): $OUT"
echo "Now run 'npm run tauri build' on this host to bundle it."

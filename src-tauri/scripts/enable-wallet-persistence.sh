#!/bin/bash
# Enable Secure-Enclave wallet persistence by embedding a provisioning profile
# and re-signing the built .app with the keychain-access-groups entitlement.
#
# WHY THIS SCRIPT EXISTS: Tauri's MacConfig has no key to embed a
# `.provisionprofile`, and macOS/AMFI SIGKILLs a hardened-runtime app that
# carries `keychain-access-groups` WITHOUT an embedded profile. So we cannot
# bake the entitlement into the normal build — we add it here, after Tauri has
# built + signed the bundle, only once a valid profile is present.
#
# PREREQUISITES (the part only the Apple account holder can do):
#   - An explicit App ID `com.tenzro.studio` in the Apple Developer portal with
#     the **Keychain Sharing** capability enabled.
#   - A current macOS `.provisionprofile` generated from that App ID, saved to
#     src-tauri/embedded.provisionprofile (default path; override with $1).
#
# USAGE:
#   1. npm run tauri build           # produces + signs the .app normally
#   2. src-tauri/scripts/enable-wallet-persistence.sh [path/to.provisionprofile]
#
# After this, launch the app, create a wallet (Touch ID), quit, relaunch, and
# confirm the wallet is still present (the node log should say
# "Wallet keystore unlocked — wallets will persist across restarts").
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # src-tauri/
PROFILE="${1:-$HERE/embedded.provisionprofile}"
APP="$HERE/target/release/bundle/macos/Tenzro Studio.app"
ENTS="$HERE/entitlements.plist"
IDENTITY="Developer ID Application: Ahmed Hilal Agil (R5FXGKNFBP)"
APP_ID="R5FXGKNFBP.com.tenzro.studio"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$PROFILE" ]] || die "no provisioning profile at: $PROFILE
  Create one in the Apple Developer portal for App ID com.tenzro.studio with
  the Keychain Sharing capability, download it, and save it to that path."
[[ -d "$APP" ]] || die "built app not found at: $APP  (run 'npm run tauri build' first)"
[[ -f "$ENTS" ]] || die "entitlements file not found at: $ENTS"

# --- Validate the profile BEFORE touching the bundle ---------------------
PLIST="$(mktemp)"; trap 'rm -f "$PLIST"' EXIT
security cms -D -i "$PROFILE" > "$PLIST" 2>/dev/null || die "cannot decode profile (not a valid .provisionprofile?)"

EXPIRY_RAW="$(/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$PLIST" 2>/dev/null || true)"
[[ -n "$EXPIRY_RAW" ]] || die "profile has no ExpirationDate"
EXPIRY_EPOCH="$(date -j -f '%a %b %d %T %Z %Y' "$EXPIRY_RAW" +%s 2>/dev/null || echo 0)"
NOW_EPOCH="$(date +%s)"
if [[ "$EXPIRY_EPOCH" != 0 && "$EXPIRY_EPOCH" -lt "$NOW_EPOCH" ]]; then
  die "profile EXPIRED on: $EXPIRY_RAW — generate a fresh one."
fi
echo "Profile expiry: $EXPIRY_RAW (ok)"

PROFILE_APPID="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$PLIST" 2>/dev/null || true)"
# Accept exact match or a team-wildcard (R5FXGKNFBP.*)
if [[ "$PROFILE_APPID" != "$APP_ID" && "$PROFILE_APPID" != "R5FXGKNFBP.*" ]]; then
  die "profile App ID '$PROFILE_APPID' does not cover '$APP_ID' (need exact or R5FXGKNFBP.* wildcard)."
fi
echo "Profile App ID: $PROFILE_APPID (covers $APP_ID)"

# --- Ensure the entitlement is active in entitlements.plist ---------------
if ! /usr/libexec/PlistBuddy -c 'Print :keychain-access-groups' "$ENTS" >/dev/null 2>&1; then
  echo "Adding keychain-access-groups to entitlements.plist ..."
  /usr/libexec/PlistBuddy -c "Add :keychain-access-groups array" "$ENTS"
  /usr/libexec/PlistBuddy -c "Add :keychain-access-groups:0 string $APP_ID" "$ENTS"
else
  echo "keychain-access-groups already present in entitlements.plist"
fi

# --- Embed the profile + re-sign -----------------------------------------
echo "Embedding profile into bundle ..."
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"

echo "Re-signing with entitlements (deep, hardened runtime) ..."
codesign --force --deep --timestamp \
  --options runtime \
  --entitlements "$ENTS" \
  --sign "$IDENTITY" \
  "$APP"

echo "Verifying signature ..."
codesign --verify --deep --strict --verbose=2 "$APP"
echo
echo "DONE. Launch the app, create a wallet, restart, and confirm it persists."
echo "If the app is SIGKILLed at launch, the profile App ID / Keychain Sharing"
echo "capability does not match — re-check the portal config."

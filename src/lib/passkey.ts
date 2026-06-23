// Passkey enrollment + signing — the device-side ceremony stays in
// the Tauri process (private key never leaves the platform secure
// enclave), the on-chain registration goes through the operator's
// `tenzro_enrollPasskey` RPC (in-process via embedded node, or HTTPS
// to rpc.tenzro.network as fallback).
//
// Design lock: passkey is the primary unlock; PIN is in-session
// re-auth only (see project_wallet_passkey_pin_design memory). No
// password fallback exists on the wallet-create path.

import { invoke } from "@tauri-apps/api/core";

/** Result of `device_create_passkey` — public key info that
 *  `tenzro_enrollPasskey` accepts as `passkey_public_key_hex`. */
export interface DeviceKeyInfo {
  label: string;
  /** Raw uncompressed SEC1 P-256 pubkey (x ‖ y, 64 bytes, no 0x04). */
  public_key_hex: string;
}

/** Result of `tenzro_enrollPasskey` — the smart-account address +
 *  DID that the user now owns. CREATE2-derived so the address is
 *  stable across reboots and reproducible from the same passkey. */
export interface EnrollResult {
  did: string;
  smart_account_address: string;
  credential_id_hex: string;
  webauthn_validator_address: string;
  installed_validators: string[];
}

/** Two-phase create-wallet:
 *
 *   1. Tauri command `device_create_passkey` mints a Secure-Enclave-
 *      backed P-256 keypair under `label`. The private key never
 *      leaves the enclave; we get back the public x ‖ y bytes.
 *   2. The pubkey is sent to `tenzro_enrollPasskey` on the embedded
 *      node, which:
 *       - registers a TDIP human identity
 *       - CREATE2-deploys the smart account
 *       - installs the WebAuthnValidator as the primary validator
 *       - persists locally (and gossips to the network on next sync)
 *
 *  Works fully offline: the smart-account address is deterministic,
 *  and the embedded node persists the registration to local
 *  RocksDB. Network sync registers it on-chain via gossip.
 *
 *  `mlDsaPublicKeyHex` is required (hybrid PQ leg). For now Studio
 *  sources it from a node-side helper that derives the ML-DSA seed
 *  from the same passkey credential id (deterministic, no extra
 *  secret to store). Until that helper ships, the caller must
 *  supply one.
 */
export async function createWalletViaPasskey(args: {
  label: string;
  displayName?: string;
  mlDsaPublicKeyHex: string;
  credentialIdHex: string;
  salt?: number;
}): Promise<EnrollResult> {
  // Step 1: device-side ceremony.
  const device = await invoke<DeviceKeyInfo>("device_create_passkey", {
    label: args.label,
  });

  // Step 2: register on the operator (via embedded-node in-process
  // RPC). When the embedded node is offline-but-running, this still
  // succeeds — registration persists locally and rebroadcasts on
  // network resume.
  const resp = await invoke<{ result?: EnrollResult; error?: { message: string } }>(
    "rpc_call",
    {
      args: {
        method: "tenzro_enrollPasskey",
        params: [
          {
            display_name: args.displayName,
            passkey_public_key_hex: device.public_key_hex,
            credential_id_hex: args.credentialIdHex,
            ml_dsa_public_key_hex: args.mlDsaPublicKeyHex,
            salt: args.salt ?? 0,
          },
        ],
      },
    },
  );
  if (resp.error) {
    throw new Error(`tenzro_enrollPasskey: ${resp.error.message}`);
  }
  if (!resp.result) {
    throw new Error("tenzro_enrollPasskey: empty result");
  }
  return resp.result;
}

/** Sign a 32-byte EIP-712 prehash with the local Secure-Enclave
 *  passkey. The ceremony pops the system biometric prompt; the
 *  returned `r ‖ s` (raw 64 bytes) is hex-encoded. */
export async function signPrehashWithPasskey(args: {
  label: string;
  prehashHex: string;
}): Promise<string> {
  return invoke<string>("device_sign_with_passkey", {
    label: args.label,
    prehashHex: args.prehashHex,
  });
}

/** Begin a FIDO caBLE cross-device ceremony — surface the QR URL to
 *  the user, then call `completeCrossDeviceSign` once the WebAuthn
 *  challenge is in hand. Spec §15.10.4. */
export async function startCrossDeviceLink(): Promise<{
  session_id: string;
  qr_url: string;
}> {
  return invoke("device_start_cross_device_link");
}

export async function completeCrossDeviceSign(args: {
  sessionId: string;
  challengeHex: string;
  rpId: string;
  allowCredentialIdsHex?: string[];
}): Promise<unknown> {
  return invoke("device_complete_cross_device_link", {
    request: {
      session_id: args.sessionId,
      challenge_hex: args.challengeHex,
      rp_id: args.rpId,
      allow_credential_ids_hex: args.allowCredentialIdsHex ?? [],
    },
  });
}

export async function cancelCrossDeviceLink(sessionId: string): Promise<void> {
  await invoke("device_cancel_cross_device_link", { sessionId });
}

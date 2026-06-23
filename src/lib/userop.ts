// UserOp 2-D nonce + sync-time revalidation helpers. Mirrors
// `tenzro_revalidateUserOp` (RPC handler in
// `~/AI/tenzronetwork/crates/tenzro-node/src/rpc.rs`) and the
// `Nonce` packer in `crates/tenzro-vm/src/account_abstraction.rs`.
//
// On reconnect after offline operation, every persisted-pending UserOp
// is re-validated against canonical chain state before broadcast. Drops
// superseded ops with a clear reason instead of silently failing.

import { invoke } from "@tauri-apps/api/core";

/** 2-D nonce per EIP-4337 v0.8: `(uint192 key << 64) | uint64 seq`.
 *  Studio uses one key per session so parallel offline signing
 *  doesn't stomp seq. The default key (all zeros) is the legacy
 *  ordered-stream every wallet supports. */
export interface Nonce {
  /** 24-byte (192-bit) key, hex without 0x prefix. */
  keyHex: string;
  /** 64-bit sequence portion. */
  seq: number | bigint;
}

/** Pack a 2-D nonce into its 32-byte big-endian uint256 hex form,
 *  ready to splice into `UserOperation.nonce`. The output is what
 *  the node's EIP-712 hasher and JSON-RPC parser both expect. */
export function packNonce(n: Nonce): string {
  const padKey = n.keyHex.padStart(48, "0");
  const seq = BigInt(n.seq);
  const seqHex = seq.toString(16).padStart(16, "0");
  return `0x${padKey}${seqHex}`;
}

/** Generate a fresh 192-bit session key. Crypto-strong randomness via
 *  the platform `crypto.getRandomValues`. Studio persists this in
 *  the settings store so all UserOps from this Studio install share
 *  the same nonce stream — different installs use different keys. */
export function newSessionKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type RevalidationStatus =
  | "valid"
  | "superseded"
  | "insufficient_funds"
  | "invalid_nonce_gap"
  | "invalid";

export interface RevalidationResult {
  status: RevalidationStatus;
  /** Echoed on `valid`, `superseded`, `invalid_nonce_gap`. */
  on_chain_seq?: number;
  /** Echoed on `superseded` / `invalid_nonce_gap` — the seq this op
   *  was signed with. */
  op_seq?: number;
  /** Echoed on `superseded` / `invalid_nonce_gap` — `0x{48-hex}`. */
  key?: string;
  /** Echoed on `insufficient_funds` — decimal string. */
  balance?: string;
  required?: string;
  /** Echoed on `invalid`. */
  reason?: string;
}

/** Re-run the on-chain `validate_user_op` against current state,
 *  without admitting the op. The wallet UI should call this for
 *  every persisted-pending UserOp on reconnect, before invoking
 *  `eth_sendUserOperation`. */
export async function revalidateUserOp(
  userOpJson: Record<string, unknown>,
): Promise<RevalidationResult> {
  const resp = await invoke<{ result?: RevalidationResult; error?: { message: string } }>(
    "rpc_call",
    {
      args: {
        method: "tenzro_revalidateUserOp",
        params: [userOpJson],
      },
    },
  );
  if (resp.error) {
    throw new Error(`tenzro_revalidateUserOp: ${resp.error.message}`);
  }
  if (!resp.result) {
    throw new Error("tenzro_revalidateUserOp: empty result");
  }
  return resp.result;
}

/** Human-readable description for surfacing in toasts / UI rows. */
export function describeRevalidation(r: RevalidationResult): string {
  switch (r.status) {
    case "valid":
      return "Ready to send";
    case "superseded":
      return `Already executed (on-chain seq ${r.on_chain_seq} ≥ your seq ${r.op_seq})`;
    case "invalid_nonce_gap":
      return `Nonce gap — expected seq ${r.on_chain_seq}, you signed seq ${r.op_seq}. Sign a fresh op.`;
    case "insufficient_funds":
      return `Insufficient funds — need ${r.required}, have ${r.balance}`;
    case "invalid":
      return r.reason ?? "Invalid";
  }
}

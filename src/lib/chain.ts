// Chain header + freshness — single source of truth for staleness
// gating in the UI. Mirrors `tenzro_currentHeader` on the embedded
// node (RPC handler in `~/AI/tenzronetwork/crates/tenzro-node/src/rpc.rs`).
//
// The wallet UI gates value transfers on `tier`:
//   - "live"          → balances trusted, sign without warning.
//   - "stale_yellow"  → show a warning chip, signing allowed.
//   - "stale_red"     → disable value transfers; allow reads only.
//   - "invalid"       → force resync, no signing.
//   - "unknown"       → no block at tip yet; defer to height alone.
//
// Staleness gating keeps value transfers from being signed against an
// out-of-date view of chain state.

import { invoke } from "@tauri-apps/api/core";

export type StalenessTier =
  | "live"
  | "stale_yellow"
  | "stale_red"
  | "invalid"
  | "unknown";

export interface CurrentHeader {
  height: number;
  hash: string;
  timestamp_secs: number;
  now_secs: number;
  age_secs: number;
  tier: StalenessTier;
}

/** Calls `tenzro_currentHeader` via the embedded node's JSON-RPC
 *  bridge. Throws when the node isn't started yet. */
export async function getCurrentHeader(): Promise<CurrentHeader> {
  const resp = await invoke<{ result?: CurrentHeader; error?: { message: string } }>(
    "rpc_call",
    { args: { method: "tenzro_currentHeader", params: [] } },
  );
  if (resp.error) {
    throw new Error(`tenzro_currentHeader: ${resp.error.message}`);
  }
  if (!resp.result) {
    throw new Error("tenzro_currentHeader: empty result");
  }
  return resp.result;
}

/** Returns true iff the current header is "live" — balances and
 *  signing decisions can rely on it without a warning. */
export function isLive(h: CurrentHeader): boolean {
  return h.tier === "live";
}

/** Returns true iff value transfers should be disabled. The wallet
 *  UI uses this to gate the Send button on the chat / wallet drawer. */
export function blocksValueTransfer(h: CurrentHeader): boolean {
  return h.tier === "stale_red" || h.tier === "invalid";
}

/** Human-readable age string for UI chips. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Mirror of `tenzro_syncing` on the embedded node. `is_syncing` is
 *  true when the median of fresh peer heights leads the local tip by
 *  more than 2 blocks (gossip-jitter tolerant). `highest_block` is
 *  the max of local + network — UI shows progress as
 *  local / highest. */
export interface SyncStatus {
  is_syncing: boolean;
  local_tip: number;
  network_tip: number;
  highest_block: number;
}

/** Call `tenzro_syncing` via the embedded node. Returns null when the
 *  node hasn't booted yet (RPC errors out — common during launch). */
export async function getSyncStatus(): Promise<SyncStatus | null> {
  try {
    const resp = await invoke<{ result?: SyncStatus; error?: { message: string } }>(
      "rpc_call",
      { args: { method: "tenzro_syncing", params: [] } },
    );
    if (resp.error || !resp.result) return null;
    return resp.result;
  } catch {
    return null;
  }
}

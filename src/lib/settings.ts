// Settings persistence — wraps tauri-plugin-store. Stored as JSON at
// the app's data dir (`settings.json`). Auto-saved on every set.
//
// Categories surfaced today (extend by adding to `SettingsShape`):
//   - appearance: theme override (light/dark/system)
//   - chat: enter-to-send, default-max-tokens, retention days
//   - inference: ctx-size override, n-gpu-layers override
//   - network: bootstrap-peers override, faucet auto-claim
//   - privacy: telemetry opt-in
//
// The actual telemetry opt-in still has its sentinel file
// `~/.tenzro/inference/telemetry.enabled` (read by the Rust side at
// boot); the settings page just creates / removes that sentinel via
// the existing `set_telemetry_enabled` Tauri command. Everything else
// lives in this store.

import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";

export type ThemePref = "system" | "light" | "dark";

export interface SettingsShape {
  theme: ThemePref;
  enterToSend: boolean;
  defaultMaxTokens: number;
  retentionDays: number; // 0 = forever
  ctxSizeOverride: number | null; // null = let hardware profile decide
  nGpuLayersOverride: number | null;
  /** Speculative decoding (MTP) toggle: when false, the preset
   *  generator skips emitting `spec-type` even for catalog entries
   *  that declare a drafter / built-in MTP head. Use to debug
   *  speed regressions or force the baseline single-model path. */
  mtpEnabled: boolean;
  /** Override the catalog-recommended `--spec-draft-n-max`. `null`
   *  uses the per-model default from `mtp_default_draft_n`. Range
   *  1..=6 per Unsloth's guidance; runtime clamps. */
  mtpDraftNMaxOverride: number | null;
  /** Force `--n-cpu-moe N`. `null` uses the hardware-profile
   *  default (0 on discrete GPUs, RAM-tier-scaled on shared-memory
   *  hosts). Useful when the auto value is too aggressive for the
   *  user's actual GPU memory headroom. */
  nCpuMoeOverride: number | null;
  // Spending caps (TNZO). 0 = no cap. Per-session is enforced inline
  // in ChatPane; per-day / per-month are reserved for when we add a
  // persistent ledger of paid requests across sessions.
  sessionSpendCapTnzo: number;
  dailySpendCapTnzo: number;
  monthlySpendCapTnzo: number;
}

const DEFAULTS: SettingsShape = {
  theme: "system",
  enterToSend: true,
  defaultMaxTokens: 4096,
  retentionDays: 0,
  ctxSizeOverride: null,
  nGpuLayersOverride: null,
  mtpEnabled: true,
  mtpDraftNMaxOverride: null,
  nCpuMoeOverride: null,
  sessionSpendCapTnzo: 0,
  dailySpendCapTnzo: 0,
  monthlySpendCapTnzo: 0,
};

let storePromise: Promise<Store> | null = null;

async function store(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(FILE, { autoSave: true, defaults: DEFAULTS as any });
  }
  return storePromise;
}

export async function getAll(): Promise<SettingsShape> {
  const s = await store();
  const out: SettingsShape = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof SettingsShape)[]) {
    const v = await s.get<SettingsShape[typeof k]>(k);
    if (v !== undefined && v !== null) {
      (out as any)[k] = v;
    }
  }
  return out;
}

export async function get<K extends keyof SettingsShape>(
  key: K,
): Promise<SettingsShape[K]> {
  const s = await store();
  const v = await s.get<SettingsShape[K]>(key);
  return v === undefined || v === null ? DEFAULTS[key] : v;
}

export async function set<K extends keyof SettingsShape>(
  key: K,
  value: SettingsShape[K],
): Promise<void> {
  const s = await store();
  await s.set(key, value);
}

export async function reset(): Promise<void> {
  const s = await store();
  await s.clear();
}

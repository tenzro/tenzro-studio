import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getAll, set, type SettingsShape, type ThemePref } from "../lib/settings";
import { MCPPanel } from "./MCPPanel";

/** Categorised settings modal — sidebar of categories + content pane,
 *  the VSCode / macOS-System-Settings pattern. Opens via Cmd-, or
 *  command palette. All settings auto-save on change (tauri-plugin-store
 *  `autoSave: true`). */
export function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [category, setCategory] = useState<Category>("general");
  const [telemetry, setTelemetry] = useState<{ enabled: boolean; available: boolean }>(
    { enabled: false, available: false },
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getAll();
        if (!cancelled) setSettings(s);
        const t = await invoke<{ enabled: boolean; available: boolean }>("telemetry_state");
        if (!cancelled) setTelemetry(t);
      } catch (e) {
        console.warn("settings load failed:", e);
        if (!cancelled) setSettings(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  async function patch<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    try {
      await set(key, value);
      if (key === "theme") {
        // Apply immediately so the user sees the effect.
        applyTheme(value as ThemePref);
      }
      // Serving overrides need a sidecar restart to take effect —
      // the Rust side handles persistence + restart in one command.
      // Only fire on the three fields that actually feed the preset.
      if (
        key === "mtpEnabled" ||
        key === "mtpDraftNMaxOverride" ||
        key === "nCpuMoeOverride"
      ) {
        // Re-read the full settings so we send a consistent triple
        // (the optimistic setState above hasn't been flushed yet).
        const next = settings ? { ...settings, [key]: value } : null;
        if (next) {
          try {
            await invoke("set_serving_overrides", {
              args: {
                mtp_enabled: next.mtpEnabled,
                mtp_draft_n_max_override: next.mtpDraftNMaxOverride,
                n_cpu_moe_override: next.nCpuMoeOverride,
              },
            });
          } catch (e) {
            console.warn("set_serving_overrides failed:", e);
          }
        }
      }
    } catch (e) {
      console.warn("settings save failed:", e);
    }
  }

  async function toggleTelemetry(next: boolean) {
    setTelemetry((t) => ({ ...t, enabled: next }));
    try {
      await invoke("set_telemetry_enabled", { enabled: next });
    } catch (e) {
      console.warn("telemetry toggle failed:", e);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[70vh] w-full max-w-3xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="w-48 shrink-0 border-r border-border bg-card/60 p-3">
          <div className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            Settings
          </div>
          <ul className="space-y-1">
            {CATEGORIES.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={`block w-full px-2 py-1.5 text-left text-sm ${
                    category === c.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-start justify-between">
            <h2 className="text-base font-semibold">
              {CATEGORIES.find((c) => c.id === category)?.label}
            </h2>
            <button
              onClick={onClose}
              className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          {!settings && (
            <p className="text-sm text-muted-foreground">Loading settings…</p>
          )}
          {settings && category === "general" && (
            <div className="space-y-4">
              <Setting label="Theme" hint="System follows your OS preference">
                <Select
                  value={settings.theme}
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                  onChange={(v) => patch("theme", v as ThemePref)}
                />
              </Setting>
            </div>
          )}
          {settings && category === "chat" && (
            <div className="space-y-4">
              <Setting
                label="Enter to send"
                hint="When off, Enter inserts a newline; ⌘↩ always sends"
              >
                <Toggle
                  value={settings.enterToSend}
                  onChange={(v) => patch("enterToSend", v)}
                />
              </Setting>
              <Setting
                label="Default max tokens"
                hint="Per-request budget unless the model's policy bumps it for thinking mode"
              >
                <NumberInput
                  value={settings.defaultMaxTokens}
                  min={256}
                  max={32768}
                  step={256}
                  onChange={(v) => patch("defaultMaxTokens", v)}
                />
              </Setting>
              <Setting
                label="History retention (days)"
                hint="0 = keep forever. Auto-deletes older conversations."
              >
                <NumberInput
                  value={settings.retentionDays}
                  min={0}
                  max={3650}
                  step={1}
                  onChange={(v) => patch("retentionDays", v)}
                />
              </Setting>
            </div>
          )}
          {settings && category === "inference" && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Defaults are auto-tuned from your hardware. Override only
                if you know what you're doing.
              </p>
              <Setting
                label="Context size override"
                hint="Blank = auto. Higher = more memory, longer contexts."
              >
                <NumberInput
                  value={settings.ctxSizeOverride ?? 0}
                  min={0}
                  max={131072}
                  step={1024}
                  onChange={(v) =>
                    patch("ctxSizeOverride", v === 0 ? null : v)
                  }
                />
              </Setting>
              <Setting
                label="GPU layers override"
                hint="999 = full GPU. 0 = CPU only."
              >
                <NumberInput
                  value={settings.nGpuLayersOverride ?? -1}
                  min={-1}
                  max={999}
                  step={1}
                  onChange={(v) =>
                    patch("nGpuLayersOverride", v === -1 ? null : v)
                  }
                />
              </Setting>
              <Setting
                label="Speculative decoding"
                hint="Built-in MTP heads (Qwen 3.5/3.6, GLM, DeepSeek) or
                      paired drafter models. Off forces single-model decode —
                      use to debug speed regressions."
              >
                <Toggle
                  value={settings.mtpEnabled}
                  onChange={(v) => patch("mtpEnabled", v)}
                />
              </Setting>
              <Setting
                label="Draft tokens per step"
                hint="Override the catalog default for `--spec-draft-n-max`.
                      Range 1–6. Higher = more speculation per step (faster
                      when the drafter agrees; slower when it doesn't).
                      Blank = use model author's recommendation."
              >
                <NumberInput
                  value={settings.mtpDraftNMaxOverride ?? 0}
                  min={0}
                  max={6}
                  step={1}
                  onChange={(v) =>
                    patch("mtpDraftNMaxOverride", v === 0 ? null : v)
                  }
                />
              </Setting>
              <Setting
                label="MoE CPU-offload layers"
                hint="`--n-cpu-moe N`: offload N top layers' MoE experts to
                      CPU, keeping GPU for the dense path + active experts.
                      Blank = auto (0 on discrete GPUs, RAM-tier-scaled on
                      Apple Silicon / iGPU / CPU-only)."
              >
                <NumberInput
                  value={settings.nCpuMoeOverride ?? -1}
                  min={-1}
                  max={128}
                  step={1}
                  onChange={(v) =>
                    patch("nCpuMoeOverride", v === -1 ? null : v)
                  }
                />
              </Setting>
            </div>
          )}
          {settings && category === "spending" && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Caps for paid network chats. 0 = no cap. Per-session is
                enforced inside each chat pane; per-day/per-month require
                a persistent ledger (coming with on-chain payment receipts).
              </p>
              <Setting label="Per-session cap (TNZO)">
                <NumberInput
                  value={settings.sessionSpendCapTnzo}
                  min={0}
                  max={100000}
                  step={1}
                  onChange={(v) => patch("sessionSpendCapTnzo", v)}
                />
              </Setting>
              <Setting label="Daily cap (TNZO)" hint="Pending: needs persistent ledger.">
                <NumberInput
                  value={settings.dailySpendCapTnzo}
                  min={0}
                  max={100000}
                  step={10}
                  onChange={(v) => patch("dailySpendCapTnzo", v)}
                />
              </Setting>
              <Setting label="Monthly cap (TNZO)" hint="Pending: needs persistent ledger.">
                <NumberInput
                  value={settings.monthlySpendCapTnzo}
                  min={0}
                  max={1000000}
                  step={100}
                  onChange={(v) => patch("monthlySpendCapTnzo", v)}
                />
              </Setting>
            </div>
          )}
          {settings && category === "mcp" && <MCPPanel />}
          {settings && category === "privacy" && (
            <div className="space-y-4">
              <Setting
                label="Crash telemetry"
                hint={
                  telemetry.available
                    ? "Opt-in. Sends crash backtraces only. No chat content. Takes effect on next app start."
                    : "Not enabled in this build (no DSN baked in)."
                }
              >
                <Toggle
                  value={telemetry.enabled}
                  disabled={!telemetry.available}
                  onChange={toggleTelemetry}
                />
              </Setting>
              <p className="text-xs text-muted-foreground">
                Everything else stays on this machine. Chat history,
                wallet shares, and downloaded models never leave your
                device.
              </p>
            </div>
          )}
          {settings && category === "about" && (
            <div className="space-y-2 text-sm">
              <KV k="App" v="Tenzro Studio" />
              <KV k="Version" v="0.1.0" />
              <KV k="License" v="Apache 2.0" />
              <KV k="Repository" v="github.com/tenzro/tenzro-studio" mono />
              <KV k="Data dir" v="~/.tenzro/inference" mono />
              <p className="mt-4 text-xs text-muted-foreground">
                Bundled: tenzro-node, llama.cpp, React, Tauri. See NOTICE
                file in the bundle for full attributions.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function applyTheme(theme: ThemePref) {
  if (theme === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

type Category = "general" | "chat" | "inference" | "spending" | "mcp" | "privacy" | "about";
const CATEGORIES: { id: Category; label: string }[] = [
  { id: "general", label: "General" },
  { id: "chat", label: "Chat" },
  { id: "inference", label: "Inference" },
  { id: "spending", label: "Spending" },
  { id: "mcp", label: "MCP" },
  { id: "privacy", label: "Privacy" },
  { id: "about", label: "About" },
];

function Setting({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border pb-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && (
          <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  value,
  disabled,
  onChange,
}: {
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative h-6 w-11 border border-border transition disabled:opacity-50 ${
        value ? "bg-primary" : "bg-secondary"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 bg-background transition ${
          value ? "left-6" : "left-0.5"
        }`}
      />
    </button>
  );
}

function NumberInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
      className="w-24 border border-border bg-background px-2 py-1 text-sm font-mono focus:outline-none focus:border-foreground"
    />
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:border-foreground"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{v}</span>
    </div>
  );
}

// MCP (Model Context Protocol) panel — wraps the four real node RPCs:
//   - tenzro_storeMcpSecret   (admin-token gated; sets a secret by ref)
//   - tenzro_forgetMcpSecret  (admin-token gated; clears it)
//   - tenzro_evictMcpSubprocess (kills a stuck tool subprocess by tool_id)
//   - tenzro_serveModelMcp / tenzro_deleteModelMcp (per-model MCP binding)
//
// The node doesn't expose a list-secrets RPC (by design — secrets are
// admin-only write+forget keyed on `sealed_secret_ref`). The panel
// tracks the secret-refs THIS user has added during the session in
// the settings store, so they have a list to manage. The actual
// secret values never leave the user's machine — they go straight to
// node.mcp_plugin_host() in-process via rpc_call.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { get as getSetting, set as setSetting } from "../lib/settings";

interface RpcResp<T = unknown> {
  result?: T;
  error?: { code: number; message: string };
}

const SECRET_REFS_KEY = "mcpSecretRefs" as any;

export function MCPPanel() {
  const [adminToken, setAdminToken] = useState("");
  const [secretRefs, setSecretRefs] = useState<string[]>([]);
  const [newRef, setNewRef] = useState("");
  const [newValue, setNewValue] = useState("");
  const [evictId, setEvictId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load known secret refs from the settings store (the panel's own
  // list — what the user has added through this UI).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const refs = await getSetting(SECRET_REFS_KEY);
        if (!cancelled && Array.isArray(refs)) setSecretRefs(refs);
      } catch { /* first launch, no key yet */ }
    })();
    return () => { cancelled = true; };
  }, []);

  async function persistRefs(refs: string[]) {
    setSecretRefs(refs);
    try { await setSetting(SECRET_REFS_KEY, refs as any); } catch { /* ignore */ }
  }

  async function storeSecret() {
    setError(null); setSuccess(null);
    if (!newRef.trim() || !newValue) {
      setError("Both name and value required");
      return;
    }
    try {
      const resp = await invoke<RpcResp>("rpc_call", {
        args: {
          method: "tenzro_storeMcpSecret",
          params: { sealed_secret_ref: newRef.trim(), plaintext: newValue },
          admin_token: adminToken || undefined,
        },
      });
      if (resp.error) throw new Error(resp.error.message);
      const next = Array.from(new Set([...secretRefs, newRef.trim()]));
      await persistRefs(next);
      setNewRef(""); setNewValue("");
      setSuccess(`Stored secret: ${newRef.trim()}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function forgetSecret(ref: string) {
    setError(null); setSuccess(null);
    try {
      const resp = await invoke<RpcResp>("rpc_call", {
        args: {
          method: "tenzro_forgetMcpSecret",
          params: { sealed_secret_ref: ref },
          admin_token: adminToken || undefined,
        },
      });
      if (resp.error) throw new Error(resp.error.message);
      await persistRefs(secretRefs.filter((r) => r !== ref));
      setSuccess(`Forgotten: ${ref}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function evictSubprocess() {
    setError(null); setSuccess(null);
    if (!evictId.trim()) {
      setError("tool_id required");
      return;
    }
    try {
      const resp = await invoke<RpcResp>("rpc_call", {
        args: {
          method: "tenzro_evictMcpSubprocess",
          params: { tool_id: evictId.trim() },
        },
      });
      if (resp.error) throw new Error(resp.error.message);
      setSuccess(`Evicted: ${evictId.trim()}`);
      setEvictId("");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-muted-foreground">
          Model Context Protocol — store secrets that MCP tools can fetch
          on-demand, and recover from stuck tool subprocesses. The plugin
          host is admin-token-gated, so store/forget require an admin
          token set in the embedded node (env <code className="font-mono">TENZRO_ADMIN_TOKEN</code>).
        </p>
      </div>

      <Setting label="Admin token" hint="Required for store/forget. Never leaves this machine.">
        <input
          type="password"
          value={adminToken}
          onChange={(e) => setAdminToken(e.target.value)}
          className="w-56 border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:border-foreground"
          placeholder="set via TENZRO_ADMIN_TOKEN"
        />
      </Setting>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Stored secrets</h4>
        <p className="text-xs text-muted-foreground">
          Tracked locally in <code className="font-mono">settings.json</code> — the values themselves live in the
          node's keyed vault and never reach this panel after store.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Name (sealed_secret_ref)
            </label>
            <input
              type="text"
              value={newRef}
              onChange={(e) => setNewRef(e.target.value)}
              placeholder="e.g. github-token"
              className="mt-1 block w-48 border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:border-foreground"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Value
            </label>
            <input
              type="password"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="••••"
              className="mt-1 block w-48 border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:border-foreground"
            />
          </div>
          <button
            type="button"
            onClick={storeSecret}
            className="border border-border bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90"
          >
            Store
          </button>
        </div>
        {secretRefs.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {secretRefs.map((ref) => (
              <li
                key={ref}
                className="flex items-center justify-between gap-3 border border-border bg-card/40 px-3 py-1.5 text-xs font-mono"
              >
                <span>{ref}</span>
                <button
                  type="button"
                  onClick={() => forgetSecret(ref)}
                  className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-destructive"
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No secrets stored from this app yet.</p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Subprocess control</h4>
        <p className="text-xs text-muted-foreground">
          Kill a stuck MCP tool subprocess by its <code className="font-mono">tool_id</code>.
          Use when a tool is hanging or not responding.
        </p>
        <div className="flex items-end gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              tool_id
            </label>
            <input
              type="text"
              value={evictId}
              onChange={(e) => setEvictId(e.target.value)}
              className="mt-1 block w-64 border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:border-foreground"
            />
          </div>
          <button
            type="button"
            onClick={evictSubprocess}
            className="border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300 hover:bg-amber-600/20"
          >
            Evict
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {success && <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>}
    </div>
  );
}

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
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { EmptyState, ModelRowSkeleton } from "@/components/Skeleton";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { WalletDrawer } from "@/components/WalletDrawer";
import { signPrehashWithPasskey, enrollPasskey, type DeviceKeyInfo } from "@/lib/passkey";
import { pickProvider } from "@/lib/routing";

function safeParseStats(s: string): AssistantStats | undefined {
  try { return JSON.parse(s) as AssistantStats; } catch { return undefined; }
}

/* -------------------------------------------------------------------------
 * Active stream registry — module-scoped so chat switches don't lose
 * in-flight responses.
 *
 * When the user sends a message in conversation A and immediately
 * switches to conversation B (or starts a new chat), `LocalModelPane`
 * stays mounted but its local `messages` state is replaced with B's
 * history. The in-flight stream for A used to write into the now-
 * displayed `messages` and persist the partial reply into whatever
 * `conversationId.current` held at the `finally` boundary — which is B,
 * not A.
 *
 * Lifting active streams out of component state fixes that:
 *  - Each stream owns the conversation id it started with (immutable).
 *  - Tokens append to a buffer keyed by conversation id, persisted to
 *    SQL every 2s so a crash mid-stream keeps history.
 *  - Subscribers (the visible LocalModelPane) re-render via `version`
 *    bumps; if the visible conversation matches the stream's, we splice
 *    the live buffer into the rendered messages.
 *  - On `done`, the final content is appended to SQL once and the
 *    registry entry is dropped.
 * ----------------------------------------------------------------------- */
interface ActiveStream {
  conversationId: string;
  modelId: string;
  content: string;
  stats: AssistantStats;
  done: boolean;
  error: string | null;
  /** Listeners that should re-render when `content` changes. */
  subscribers: Set<() => void>;
}

const ACTIVE_STREAMS = new Map<string, ActiveStream>();

function getActiveStream(conversationId: string): ActiveStream | undefined {
  return ACTIVE_STREAMS.get(conversationId);
}

function subscribeStream(conversationId: string, cb: () => void): () => void {
  const s = ACTIVE_STREAMS.get(conversationId);
  if (!s) return () => {};
  s.subscribers.add(cb);
  return () => { s.subscribers.delete(cb); };
}

function notifyStream(s: ActiveStream) {
  for (const cb of s.subscribers) cb();
}

/** Mirror of `ChatEvent` in src-tauri/src/streaming.rs — one variant
 *  per `kind` discriminator. */
type ChatEvent =
  | { kind: "started"; request_id: string; ttft_ms: number }
  | { kind: "delta"; content: string }
  | { kind: "usage"; prompt_tokens: number; completion_tokens: number; tok_per_sec: number }
  | { kind: "done"; finish_reason: string }
  | { kind: "error"; message: string };

interface AssistantStats {
  ttft_ms?: number;
  tok_per_sec?: number;
  completion_tokens?: number;
  prompt_tokens?: number;
  finish_reason?: string;
}

/** Mirror of `NodeStatusView` in src-tauri/src/node_lifecycle.rs. */
interface NodeStatus {
  state: string;
  /** Comma-joined set of roles this node serves (e.g.
   * "validator,model_provider,storage"). One node, one stake, many roles. */
  roles: string;
  block_height: number;
  peer_count: number;
  uptime_secs: number;
  tee_capable: boolean;
  iroh_enabled: boolean;
  connectivity: "connecting" | "syncing" | "connected";
}

/** Human label for a comma-joined role set, e.g.
 * "validator,model_provider" -> "Validator, AI". */
function formatRoles(roles: string | undefined): string {
  if (!roles) return "—";
  const labels: Record<string, string> = {
    validator: "Validator",
    model_provider: "AI",
    ai: "AI",
    tee_provider: "TEE",
    tee: "TEE",
    storage: "Storage",
    full_node: "Full node",
    light_client: "Light client",
  };
  return roles
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => labels[r] ?? r)
    .join(", ");
}

/** Union the node's current role set with `add`, returning a comma-joined
 * string for `request_role_change`. The node replaces its role set wholesale,
 * so the GUI sends the full desired set — one stake, many roles. */
function withRole(current: string | undefined, add: string): string {
  const set = new Set(
    (current ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
  );
  set.add(add);
  return Array.from(set).join(",");
}

/** Subset of the model record returned by `tenzro_listModels`. */
interface ModelInfo {
  id: string;
  name: string;
  family: string;
  parameters: string;
  architecture: string;
  context_length: number;
  quantization?: string;
  size_bytes?: number;
  min_ram_gb?: number;
  license?: string;
  description?: string;
  hf_repo?: string;
  /** True when the GGUF is present on disk at `~/.tenzro/models/`. */
  downloaded?: boolean;
  download_status?: string;
  serving?: boolean;
  availability?: string;
  pricing?: {
    input_per_token_wei?: string;
    output_per_token_wei?: string;
    currency?: string;
  };
}

/** Subset of `tenzro_listModelEndpoints` entries. */
type ModelEndpoint = import("../lib/routing").ModelEndpoint;

/** Subset of `tenzro_getDownloadProgress` state. Field names mirror the
 *  Rust `ModelDownloadStatus` struct in `crates/tenzro-node/src/node.rs`. */
interface DownloadProgress {
  model_id: string;
  status: string;
  progress_percent?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string | null;
}

type CardId = "use-network" | "run-local" | "serve" | "provide" | "validate";

interface Card {
  id: CardId;
  title: string;
  tagline: string;
  body: string;
}

const CARDS: Card[] = [
  {
    id: "use-network",
    title: "Use Tenzro Network",
    tagline: "Chat with models served by the network",
    body:
      "Pick a model from the network catalog, chat, pay per token. " +
      "No GPU required, no local downloads.",
  },
  {
    id: "run-local",
    title: "Run AI locally",
    tagline: "Download a model, chat in private",
    body:
      "Download a model from the registry, run it on your machine " +
      "with Metal / CUDA / ROCm acceleration. Stays on your device.",
  },
  {
    id: "serve",
    title: "Serve AI to the network",
    tagline: "Earn TNZO by serving models you run",
    body:
      "Pick a model, advertise it to the network as a provider, " +
      "earn TNZO from AI requests. Requires capable hardware.",
  },
  {
    id: "provide",
    title: "Provide storage & compute",
    tagline: "Earn TNZO by hosting storage and renting out compute",
    body:
      "Offer your spare disk and CPU/GPU to the network. One stake, " +
      "many roles — paid per byte stored and per epoch rented.",
  },
  {
    id: "validate",
    title: "Run a validator",
    tagline: "Deposit TNZO and help secure the network",
    body:
      "Advanced. Deposit TNZO, help secure the network, " +
      "earn validator rewards. Requires uptime + a refundable deposit.",
  },
];

/** Thin wrapper around the Tauri `rpc_call` command. */
async function rpc<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const resp = await invoke<{ result?: T; error?: { code: number; message: string } }>(
    "rpc_call",
    { args: { method, params } },
  );
  if (resp.error) throw new Error(resp.error.message);
  return resp.result as T;
}

/** Restart the llama-server sidecar so its router re-scans the
 *  models-dir and picks up a model that finished downloading after the
 *  sidecar booted. Best-effort: errors are logged, not thrown, because
 *  the chat-time 400 "model not found" backstop will restart + retry
 *  anyway if this refresh didn't land in time. */
async function refreshSidecarModels(): Promise<void> {
  try {
    await invoke("sidecar_refresh_models");
  } catch (e) {
    console.warn("sidecar_refresh_models failed (chat-time retry will cover):", e);
  }
}

export default function Home() {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [picked, setPicked] = useState<CardId | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const s = await invoke<NodeStatus | null>("node_status");
        if (s) setStatus(s);
      } catch {
        /* non-fatal during boot */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  if (picked) {
    return (
      <WalletProvider>
        <CardFlow
          cardId={picked}
          onBack={() => setPicked(null)}
          status={status}
        />
      </WalletProvider>
    );
  }

  return (
    <WalletProvider>
    <div className="tnz-ambient flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-5xl flex-1 px-8 pt-24 pb-16">
        <header className="mb-16 max-w-2xl">
          <p className="tnz-eyebrow">Tenzro Studio</p>
          <h1 className="mt-5 text-5xl font-semibold leading-[1.05] tracking-tight">
            Run, serve, and secure{" "}
            <span className="tnz-dim">intelligence on the network.</span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            One client for the whole Tenzro Network — chat with models others
            serve, run them privately on your own hardware, earn by serving,
            or stake to validate.
          </p>
        </header>

        <section>
          <p className="tnz-eyebrow mb-5">Choose a path</p>
          <div className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2">
            {CARDS.map((card) => (
              <button
                key={card.id}
                onClick={() => setPicked(card.id)}
                className="group relative bg-background p-7 text-left transition-colors hover:bg-secondary"
              >
                <span className="tnz-eyebrow block">{cardGlyph(card.id)}</span>
                <h3 className="mt-4 text-lg font-medium tracking-tight">
                  {card.title}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {card.tagline}
                </p>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground/90">
                  {card.body}
                </p>
                {/* Hairline brand-accent reveal on hover — the one place the
                    periwinkle touches the cards. */}
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-px scale-x-0 bg-[var(--brand)] transition-transform duration-200 group-hover:scale-x-100"
                />
              </button>
            ))}
          </div>
        </section>
      </main>

      <StatusBar status={status} />
    </div>
    </WalletProvider>
  );
}

/** Two-letter mono glyph per card — a structural label that encodes the
 *  action, not a decorative 01/02 sequence (these paths are parallel,
 *  not ordered). */
function cardGlyph(id: CardId): string {
  switch (id) {
    case "use-network": return "NET";
    case "run-local": return "LOC";
    case "serve": return "SRV";
    case "provide": return "PRV";
    case "validate": return "VAL";
  }
}

function StatusBar({ status }: { status: NodeStatus | null }) {
  const [restarting, setRestarting] = useState(false);

  if (!status) {
    return (
      <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card px-6 py-3 text-xs text-muted-foreground">
        Starting embedded node…
      </footer>
    );
  }
  const dotColor =
    status.connectivity === "connected"
      ? "bg-emerald-500"
      : status.connectivity === "syncing"
        ? "bg-amber-500"
        : "bg-muted-foreground";

  // Surface a Retry affordance if we've been "connecting" for too long
  // (>30 s of uptime with zero peers). Most likely the prior process
  // died mid-dial and left libp2p state in a confused position — a
  // clean restart of just the node usually fixes it.
  const showRetry = status.connectivity === "connecting" && status.uptime_secs > 30;
  // Escalate to a chain-reset offer when Retry alone hasn't helped: if
  // we've been "connecting" for >120 s with zero peers, the local
  // RocksDB is almost certainly carrying state above the network's
  // current genesis (testnet sweep / rollback). Retry alone can't fix
  // that — only wiping db/ + snapshots/ will, because the libp2p
  // identify handshake against the fleet rejects us on the
  // chain-id/height mismatch.
  const showReset = status.connectivity === "connecting" && status.uptime_secs > 120;

  async function retry() {
    if (restarting) return;
    setRestarting(true);
    try {
      await invoke("restart_node");
    } catch (e) {
      console.error("restart_node failed:", e);
    } finally {
      // status poll will reflect the new node — just clear the local
      // "restarting" flag after a beat so the spinner state ends.
      setTimeout(() => setRestarting(false), 1500);
    }
  }

  async function resetChain() {
    if (restarting) return;
    const ok = window.confirm(
      "Reset local chain state?\n\n" +
        "Your node has been unable to connect for over 2 minutes. " +
        "The network may have been reset to a new genesis (common during " +
        "testnet sweeps), in which case your local chain data is " +
        "incompatible and must be wiped to reconnect.\n\n" +
        "This wipes: chain database + snapshots.\n" +
        "Preserved: your keys, wallets, agent memory, downloaded models.\n\n" +
        "Proceed?"
    );
    if (!ok) return;
    setRestarting(true);
    try {
      await invoke("reset_local_chain");
    } catch (e) {
      console.error("reset_local_chain failed:", e);
      window.alert("Chain reset failed: " + String(e));
    } finally {
      setTimeout(() => setRestarting(false), 1500);
    }
  }

  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-6 border-t border-border bg-card px-6 py-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dotColor}`} />
        <span className="capitalize">{status.connectivity}</span>
      </div>
      <Sep />
      <span>
        <span className="text-muted-foreground/70">Peers</span>{" "}
        <span className="font-mono text-foreground">{status.peer_count}</span>
      </span>
      <Sep />
      <span>
        <span className="text-muted-foreground/70">Block</span>{" "}
        <span className="font-mono text-foreground">
          {status.block_height.toLocaleString()}
        </span>
      </span>
      <Sep />
      <span className="text-muted-foreground/70">{formatRoles(status.roles)}</span>
      <Sep />
      <span className="text-muted-foreground/70">
        Uptime {Math.floor(status.uptime_secs / 60)}m
      </span>
      <Sep />
      <WalletChip />
      {showRetry && !showReset && (
        <>
          <Sep />
          <button
            onClick={retry}
            disabled={restarting}
            className="border border-border bg-secondary px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent disabled:opacity-50"
          >
            {restarting ? "Restarting…" : "Retry connection"}
          </button>
        </>
      )}
      {showReset && (
        <>
          <Sep />
          <button
            onClick={retry}
            disabled={restarting}
            className="border border-border bg-secondary px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent disabled:opacity-50"
          >
            {restarting ? "Restarting…" : "Retry"}
          </button>
          <button
            onClick={resetChain}
            disabled={restarting}
            className="border border-amber-600/40 bg-amber-600/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-amber-200 hover:bg-amber-600/20 disabled:opacity-50"
            title="Wipe local chain data and reconnect — needed after a network genesis reset"
          >
            Reset local chain
          </button>
        </>
      )}
    </footer>
  );
}

function Sep() {
  return <span className="text-muted-foreground/40">·</span>;
}

/* --------------------------------------------------------------------- */
/* Wallet                                                                 */
/* --------------------------------------------------------------------- */

/** Wallet snapshot returned by the `wallet_status` Tauri command. */
interface WalletStatus {
  exists: boolean;
  address: string;
  display_address: string;
  balance_wei: string;
  balance_display: string;
  node_ready: boolean;
}

interface WalletContextValue {
  status: WalletStatus | null;
  refresh: () => void;
}

/** Single source of wallet truth for the whole page. Without this, each
 *  `useWallet()` call site kept its own `useState`, so creating a wallet in
 *  one component (e.g. the card flow's `RequireWallet`) never updated the
 *  status-bar chip or the validator flow. The provider polls once and fans
 *  the snapshot out; `refresh()` re-probes immediately for every consumer. */
const WalletContext = createContext<WalletContextValue | null>(null);

function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const s = await invoke<WalletStatus>("wallet_status");
        if (!cancelled) setStatus(s);
      } catch (e) {
        // Node not up yet (or a transient command error). Report
        // not-ready WITHOUT gating on the closure-captured `status`,
        // which is stale across the setTimeout chain — gating on it
        // would freeze the chip permanently after the first error even
        // once the node comes up. A later successful poll overwrites this.
        if (!cancelled) setStatus({
          exists: false, address: "", display_address: "",
          balance_wei: "0", balance_display: "—", node_ready: false,
        });
      }
      timer = setTimeout(poll, 8_000);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const value = useMemo<WalletContextValue>(
    () => ({ status, refresh: () => setTick((t) => t + 1) }),
    [status],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Read the shared wallet snapshot + refresh trigger. Must be rendered under
 *  a [`WalletProvider`]. */
function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}

/** Status-bar wallet chip: shows "No wallet" + Create button when none
 *  exists, or "{balance} TNZO" + a clickable chip that opens the
 *  wallet details modal. Auto-faucets 10,000 TNZO on first create
 *  (testnet onboarding). */
function WalletChip() {
  const { status, refresh } = useWallet();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Listen for the native "Wallet" menu item (Cmd-Shift-W) — open
  // the drawer. Idempotent if already open.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u = await listen<string>("menu-event", (ev) => {
          if (ev.payload === "wallet") setOpen(true);
        });
        unlisten = u;
      } catch { /* ignore */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      // Step 1: device-side passkey ceremony — mints a P-256 keypair
      // in the platform secure enclave (macOS Secure Enclave / Windows
      // Hello / Linux libsecret), gated by the platform biometric
      // prompt. The private key never leaves the enclave; we receive
      // only the public SEC1 `x ‖ y` bytes.
      const label = `tenzro-wallet-${Date.now()}`;
      // Mint a biometry-gated P-256 key in the Secure Enclave. Note:
      // key *generation* does NOT trigger Touch ID on macOS — only key
      // *use* (signing) does.
      // Mints the P-256 enclave key AND seals an ML-DSA-65 post-quantum
      // companion seed to it, returning both public keys + the credential
      // id. Neither generation nor sealing triggers Touch ID.
      const dk = await invoke<DeviceKeyInfo>(
        "device_create_passkey",
        { label },
      );
      // Force the user-presence ceremony: sign a fixed enrollment
      // challenge with the freshly-minted key. This is what pops Touch
      // ID and proves the user controls the enclave key before we bind
      // it to the wallet. Throws if the user cancels the prompt.
      const challenge =
        "0000000000000000000000000000000000000000000000000000000000000001";
      await signPrehashWithPasskey({ label, prehashHex: challenge });
      // On-chain enrollment: registers a TDIP identity, CREATE2-deploys the
      // smart account, and installs the WebAuthnValidator with the hybrid
      // P-256 + ML-DSA-65 custody key. Persists locally and gossips on sync.
      const enrolled = await enrollPasskey(dk, label);
      // Provision the local MPC wallet on the embedded node. Future signing
      // flows use `device_sign_hybrid_with_passkey` for both custody legs.
      await invoke<WalletStatus>("wallet_create");
      console.info(
        "Wallet created with device-bound passkey",
        label,
        dk.public_key_hex.slice(0, 16) + "…",
        "→",
        enrolled.smart_account_address,
      );
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  if (!status) {
    return <span className="text-muted-foreground/70">Wallet …</span>;
  }
  if (!status.node_ready) {
    return <span className="text-muted-foreground/70">Wallet (node starting)</span>;
  }
  if (!status.exists) {
    return (
      <>
        <span className="text-muted-foreground/70">No wallet</span>
        <button
          type="button"
          onClick={create}
          disabled={creating}
          className="ml-2 border border-emerald-600/40 bg-emerald-600/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400 hover:bg-emerald-600/20 disabled:opacity-50"
          title="Create a new MPC wallet. You'll be credited 10,000 TNZO on testnet."
        >
          {creating ? "Creating…" : "Create wallet"}
        </button>
        {error && (
          <span className="ml-2 text-destructive">{error}</span>
        )}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-foreground hover:underline"
        title={`Wallet: ${status.display_address} — click for details`}
      >
        <span className="font-mono">{status.balance_display}</span>{" "}
        <span className="text-muted-foreground/70">TNZO</span>
      </button>
      {open && (
        <WalletDrawer
          status={status}
          onClose={() => setOpen(false)}
          onRefresh={refresh}
        />
      )}
    </>
  );
}

interface CardFlowProps {
  cardId: CardId;
  onBack: () => void;
  status: NodeStatus | null;
}

function CardFlow({ cardId, onBack, status }: CardFlowProps) {
  const card = CARDS.find((c) => c.id === cardId)!;
  return (
    <div className="tnz-ambient flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-5xl flex-1 px-8 pt-12 pb-16">
        <button
          onClick={onBack}
          className="tnz-eyebrow mb-8 inline-flex items-center gap-1.5 hover:text-foreground"
        >
          <span aria-hidden>←</span> Back
        </button>
        <p className="tnz-eyebrow">{cardGlyph(card.id)}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">{card.title}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{card.tagline}</p>

        <div className="mt-10">
          {cardId === "use-network" && (
            <RequireWallet reason="You need a wallet to pay providers for inference.">
              <UseNetworkFlow />
            </RequireWallet>
          )}
          {cardId === "run-local" && <RunLocalFlow />}
          {cardId === "serve" && (
            <RequireWallet reason="You need a wallet to receive TNZO payments from inference requests routed to your node.">
              <ServeFlow />
            </RequireWallet>
          )}
          {cardId === "provide" && (
            <RequireWallet reason="You need a wallet to receive TNZO payments for storage hosted and compute rented.">
              <ProvideFlow />
            </RequireWallet>
          )}
          {cardId === "validate" && (
            <RequireWallet reason="You need a wallet to deposit TNZO and receive validator rewards.">
              <ValidatorFlow />
            </RequireWallet>
          )}
        </div>
      </main>
      <StatusBar status={status} />
    </div>
  );
}

/** Loads the catalog from the embedded node. The catalog comes from
 *  the network (the node syncs it from the registry), so it can be
 *  unavailable for a while when the node is still "connecting". Rather
 *  than hard-failing after a fixed window — which strands the user on a
 *  dead error and, worse, blocks the Run-Local flow that doesn't even
 *  need the network — we retry indefinitely with backoff and expose a
 *  non-fatal `waiting` flag so the UI can show a calm "waiting for
 *  network" state instead of an error. Once the catalog loads it
 *  settles into a slow refresh so newly-advertised models appear. */
function useCatalog() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  // `waiting` is true while we've never successfully loaded and are
  // still retrying — distinct from a hard error (which we no longer
  // raise for the boot/connecting window).
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let everLoaded = false;
    let backoff = 2_000;

    // Offline-first fallback: read the bundled catalog + on-disk
    // contents via the local Tauri command. Shows the user's downloaded
    // models so they can keep working even with no network.
    const loadLocal = async (): Promise<ModelInfo[] | null> => {
      try {
        const list = await invoke<ModelInfo[]>("local_models");
        return list;
      } catch (e) {
        console.warn("local_models failed:", e);
        return null;
      }
    };

    const attempt = async () => {
      if (cancelled) return;
      // If the browser tells us we're offline, skip the network RPC
      // entirely and show the local fallback. We still schedule a slow
      // retry so we pick up connectivity when it returns.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        const local = await loadLocal();
        if (cancelled) return;
        if (local !== null) {
          setModels(local);
          setWaiting(false);
          everLoaded = true;
        } else if (!everLoaded) {
          setWaiting(true);
        }
        // Long retry — network only comes back when 'online' fires;
        // this is the safety net if the event is missed.
        timer = setTimeout(attempt, 60_000);
        return;
      }
      try {
        const list = await rpc<ModelInfo[]>("tenzro_listModels");
        if (cancelled) return;
        setModels(list);
        setWaiting(false);
        everLoaded = true;
        backoff = 2_000;
        timer = setTimeout(attempt, 10_000);
      } catch {
        if (cancelled) return;
        // Network RPC failed. Fall back to the local catalog so the
        // user can still use downloaded models, then back off harder
        // before retrying the network call.
        const local = await loadLocal();
        if (cancelled) return;
        if (local !== null && local.length > 0) {
          setModels(local);
          setWaiting(false);
          everLoaded = true;
        } else if (!everLoaded) {
          setWaiting(true);
        }
        backoff = Math.min(backoff * 2, 60_000);
        timer = setTimeout(attempt, backoff);
      }
    };

    attempt();

    // `online` event: try immediately when the browser thinks we're
    // back. Saves the user from waiting out the backoff window.
    const onOnline = () => {
      if (cancelled) return;
      backoff = 2_000;
      if (timer) { clearTimeout(timer); timer = null; }
      attempt();
    };
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return { models, waiting };
}

/** Lists models physically present on disk by asking the sidecar
 *  (llama-server router) directly — independent of the node/network.
 *  Used as a fallback so already-downloaded models remain usable while
 *  the node is still connecting and the full catalog is unavailable.
 *  Returns `null` until the first probe resolves, then a (possibly
 *  empty) list. */
function useLocalModels() {
  const [local, setLocal] = useState<ModelInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const probe = async () => {
      if (cancelled) return;
      try {
        const raw = await invoke<{ data?: { id: string }[]; models?: { id: string }[] }>(
          "sidecar_list_models",
        );
        if (cancelled) return;
        const entries = raw?.data ?? raw?.models ?? [];
        setLocal(
          entries.map((e) => localModelFromId(e.id)),
        );
      } catch {
        if (cancelled) return;
        // Sidecar may still be spawning — treat as "none yet" and keep
        // polling so models appear as soon as it's up.
        setLocal((prev) => prev ?? []);
      }
      timer = setTimeout(probe, 4_000);
    };

    probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return local;
}

/** Polls the llama-server sidecar's readiness, independent of the
 *  node. `ready` means the engine is alive AND not mid-load (HTTP 200);
 *  `loading` means alive but a model is still loading (HTTP 503). Used
 *  to gate chat sends and to drive the queue-and-auto-send behaviour so
 *  a user who hits Send before the engine is up isn't met with an
 *  error — their message waits and fires when the sidecar is ready. */
function useSidecarReady() {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const s = await invoke<{
          spawned?: boolean;
          alive?: boolean;
          http_status?: number;
        }>("sidecar_status");
        if (cancelled) return;
        const alive = !!s?.alive;
        setReady(alive && s?.http_status === 200);
        setLoading(alive && s?.http_status === 503);
      } catch {
        if (cancelled) return;
        setReady(false);
        setLoading(false);
      }
      // Poll faster until ready, then back off to a light heartbeat.
      timer = setTimeout(poll, ready ? 5_000 : 1_000);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ready, loading };
}

/** Build a minimal ModelInfo from a sidecar model id (GGUF stem). We
 *  don't have catalog metadata offline, so fields the UI tolerates as
 *  optional are left empty; the model is by definition downloaded. */
function localModelFromId(id: string): ModelInfo {
  return {
    id,
    name: id,
    family: "local",
    parameters: "",
    architecture: "",
    context_length: 0,
    downloaded: true,
  };
}

/** Calm, non-blocking banner shown while the node is still connecting
 *  and the network catalog hasn't loaded. Never an error — the app
 *  keeps working with whatever is available locally. */
function WaitingForNetwork({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 border border-border bg-card text-xs text-muted-foreground ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
      <span>Waiting for the network catalog — connecting…</span>
    </div>
  );
}

/** Loads which models have live serving endpoints on the network.
 *  Same boot-window retry strategy as `useCatalog`: silently retry
 *  every 2 s until the node is up, then settle into a 5 s refresh
 *  cadence. */
function useEndpoints() {
  const [endpoints, setEndpoints] = useState<ModelEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      if (cancelled) return;
      try {
        const raw = await rpc<unknown>("tenzro_listModelEndpoints");
        if (cancelled) return;
        const arr: ModelEndpoint[] = Array.isArray(raw)
          ? (raw as ModelEndpoint[])
          : ((raw as { services?: ModelEndpoint[]; endpoints?: ModelEndpoint[] })
              .services ?? (raw as { endpoints?: ModelEndpoint[] }).endpoints ?? []);
        setEndpoints(arr);
        setError(null);
        timer = setTimeout(load, 5_000);
      } catch (e) {
        if (cancelled) return;
        const elapsed = Date.now() - started;
        if (elapsed < 30_000) {
          timer = setTimeout(load, 2_000);
        } else {
          setError(String(e));
          timer = setTimeout(load, 5_000); // keep trying even after surfacing error
        }
      }
    };

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { endpoints, error };
}

/* --------------------------------------------------------------------- */
/* Use Tenzro Network — remote-provider chat                              */
/* --------------------------------------------------------------------- */

function UseNetworkFlow() {
  const { models, waiting } = useCatalog();
  const { endpoints, error: epErr } = useEndpoints();
  const [picked, setPicked] = useState<ModelInfo | null>(null);

  // Map model_id -> list of providers serving it.
  const providersByModel = new Map<string, ModelEndpoint[]>();
  for (const ep of endpoints ?? []) {
    const list = providersByModel.get(ep.model_id) ?? [];
    list.push(ep);
    providersByModel.set(ep.model_id, list);
  }

  if (picked) {
    const providers = providersByModel.get(picked.id) ?? [];
    return (
      <ChatPane
        model={picked}
        providers={providers}
        onBack={() => setPicked(null)}
      />
    );
  }

  if (!models) {
    return (
      <div className="space-y-3">
        {waiting && <WaitingForNetwork />}
        <div className="space-y-2" aria-busy="true" aria-label="Loading network catalog">
          <ModelRowSkeleton />
          <ModelRowSkeleton />
          <ModelRowSkeleton />
          <ModelRowSkeleton />
        </div>
      </div>
    );
  }
  if (models.length === 0) {
    return (
      <EmptyState
        title="No models on the network yet"
        body="The embedded node is still syncing with peers. Models appear here as providers advertise them via gossipsub."
      />
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-baseline gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>{models.length} models · </span>
        <span>
          {endpoints
            ? `${endpoints.length} live provider endpoint${endpoints.length === 1 ? "" : "s"}`
            : epErr
              ? "providers unknown"
              : "checking providers…"}
        </span>
      </div>
      <ul className="space-y-2">
        {models.map((m) => {
          const providers = providersByModel.get(m.id) ?? [];
          return (
            <li key={m.id}>
              <button
                onClick={() => setPicked(m)}
                className="w-full border border-border bg-card p-4 text-left transition hover:bg-accent"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">{m.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {m.family} · {m.parameters} ·{" "}
                      {m.context_length.toLocaleString()} ctx
                      {m.quantization ? ` · ${m.quantization}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <PricingTag pricing={m.pricing} />
                    <ProviderBadge count={providers.length} />
                  </div>
                </div>
                {m.description && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {m.description}
                  </p>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProviderBadge({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="text-xs text-muted-foreground">No live providers</span>
    );
  }
  return (
    <span className="text-xs text-emerald-600 dark:text-emerald-400">
      {count} provider{count === 1 ? "" : "s"} live
    </span>
  );
}

function PricingTag({ pricing }: { pricing?: ModelInfo["pricing"] }) {
  if (!pricing?.input_per_token_wei) {
    return (
      <span className="text-xs text-muted-foreground">Pricing on request</span>
    );
  }
  const inputTnzo = Number(BigInt(pricing.input_per_token_wei)) / 1e18;
  const outputTnzo = pricing.output_per_token_wei
    ? Number(BigInt(pricing.output_per_token_wei)) / 1e18
    : null;
  return (
    <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
      {inputTnzo.toFixed(6)}
      {outputTnzo !== null ? ` / ${outputTnzo.toFixed(6)}` : ""}{" "}
      {pricing.currency ?? "TNZO"}/token
    </span>
  );
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** Per-message stats for assistant turns; absent on user turns. */
  stats?: AssistantStats;
  /** True while the assistant turn is mid-stream. */
  streaming?: boolean;
}

/**
 * Chat against a remote provider for a specific model. We POST OpenAI-
 * compatible chat completions directly to the provider's HTTP endpoint
 * (returned by `tenzro_listModelEndpoints`). This bypasses the embedded
 * node's local ModelRuntime — the request goes straight to whichever
 * provider on the network has the model loaded.
 */
function ChatPane({
  model,
  providers,
  onBack,
}: {
  model: ModelInfo;
  providers: ModelEndpoint[];
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Session-cost tracker. Bumped on every successful response; resets
  // when the pane unmounts.
  const [sessionCostTnzo, setSessionCostTnzo] = useState(0);
  const [firstPaidConfirmed, setFirstPaidConfirmed] = useState(false);
  // Per-session spending cap loaded from settings (0 = no cap).
  const [sessionCap, setSessionCap] = useState(0);
  useEffect(() => {
    let cancelled = false;
    import("../lib/settings").then(async (s) => {
      const cap = await s.get("sessionSpendCapTnzo");
      if (!cancelled) setSessionCap(cap ?? 0);
    });
    return () => { cancelled = true; };
  }, []);

  // Route to the healthiest, least-loaded provider rather than blindly
  // taking the first. Recomputed when the endpoint list refreshes.
  const provider = useMemo(() => pickProvider(providers), [providers]);

  if (!provider) {
    return (
      <div>
        <BackBtn onClick={onBack} />
        <ModelHeader model={model} />
        <div className="mt-8 border border-border bg-card p-6">
          <h3 className="text-sm font-medium">No live providers for this model.</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            This model is in the network catalog but no provider is
            currently serving it. To use it now, switch to{" "}
            <span className="font-medium text-foreground">Run AI locally</span>{" "}
            from the home screen and download it on your machine.
          </p>
        </div>
      </div>
    );
  }

  // Per-token pricing (TNZO/token). Falls back to 0 when missing so the
  // estimate doesn't error — it just shows "free / not priced".
  const inWeiPerTok = model.pricing?.input_per_token_wei
    ? BigInt(model.pricing.input_per_token_wei) : 0n;
  const outWeiPerTok = model.pricing?.output_per_token_wei
    ? BigInt(model.pricing.output_per_token_wei) : inWeiPerTok;
  const inputTokensEstimate = Math.max(1, Math.ceil(input.trim().length / 4));
  const estCostTnzo = Number(BigInt(inputTokensEstimate) * inWeiPerTok) / 1e18;

  async function send() {
    if (!input.trim() || sending || !provider) return;

    // Spending cap check: refuse if this request would push us past
    // the per-session cap. 0 = no cap.
    if (sessionCap > 0 && sessionCostTnzo + estCostTnzo > sessionCap) {
      setError(
        `Per-session spend cap (${sessionCap} TNZO) would be exceeded. Raise it in Settings → Spending, or start a new chat.`,
      );
      return;
    }

    // First-paid confirm: once per session, native OS dialog.
    if (!firstPaidConfirmed && inWeiPerTok > 0n) {
      let ok = false;
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        ok = await confirm(
          `This chat is paid. ${model.name} costs ~${estCostTnzo.toFixed(6)} TNZO for this prompt and continues to bill per response token. Continue?`,
          { title: "Paid chat — first confirmation", kind: "info" },
        );
      } catch {
        ok = window.confirm(`Paid chat at ~${estCostTnzo.toFixed(6)} TNZO. Continue?`);
      }
      if (!ok) return;
      setFirstPaidConfirmed(true);
    }

    const userMsg: ChatMsg = { role: "user", content: input };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setSending(true);
    setError(null);
    try {
      const body = JSON.stringify({
        model: model.id,
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
      });
      const base = provider.api_url ?? provider.api_endpoint ?? "";
      const url = base.replace(/\/$/, "") + "/v1/chat/completions";
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const content =
        data?.choices?.[0]?.message?.content ??
        data?.content ??
        JSON.stringify(data);
      setMessages((m) => [...m, { role: "assistant", content }]);
      // Bill: prompt tokens × input price + completion tokens × output price.
      const promptToks = data?.usage?.prompt_tokens ?? inputTokensEstimate;
      const completionToks = data?.usage?.completion_tokens ?? 0;
      const cost = Number(
        BigInt(promptToks) * inWeiPerTok +
        BigInt(completionToks) * outWeiPerTok
      ) / 1e18;
      setSessionCostTnzo((c) => c + cost);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <BackBtn onClick={onBack} />
      <ModelHeader model={model} extra={`via ${provider.provider_name ?? provider.provider ?? "remote"}`} />
      <div className="mt-2 flex items-center justify-between gap-3 border border-border bg-card/40 px-4 py-2 text-xs">
        <div className="text-muted-foreground">
          {inWeiPerTok > 0n ? (
            <>
              <span className="font-mono">{(Number(inWeiPerTok) / 1e18).toFixed(6)}</span>
              {" / "}
              <span className="font-mono">{(Number(outWeiPerTok) / 1e18).toFixed(6)}</span>
              {" TNZO per input/output token"}
            </>
          ) : (
            <span>Free (no pricing set)</span>
          )}
        </div>
        <div className="text-muted-foreground">
          This session:{" "}
          <span className="font-mono text-foreground">{sessionCostTnzo.toFixed(6)}</span>{" TNZO"}
        </div>
      </div>
      {input.trim() && inWeiPerTok > 0n && (
        <div className="mt-1 text-right text-xs text-muted-foreground">
          Next request ~<span className="font-mono">{estCostTnzo.toFixed(6)}</span> TNZO
          (estimated · {inputTokensEstimate} prompt tokens)
        </div>
      )}
      <ChatBox
        messages={messages}
        input={input}
        setInput={setInput}
        sending={sending}
        error={error}
        onSend={send}
        placeholder={`Message ${model.name}…`}
      />
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Run AI locally — download + load + chat against embedded ModelRuntime  */
/* --------------------------------------------------------------------- */

function RunLocalFlow() {
  const { models, waiting } = useCatalog();
  // Models already on disk, discovered directly from the sidecar — this
  // path does NOT depend on the node/network, so a downloaded model
  // stays usable while the node is still "connecting".
  const local = useLocalModels();
  const [picked, setPicked] = useState<ModelInfo | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  // Local refresh trigger — bumped after a successful offload so the
  // list re-fetches and the Downloaded badge disappears.
  const [refreshTick, setRefreshTick] = useState(0);
  // Host RAM for the model-row fit indicator (LM-Studio pattern).
  const hostRamGb = useHostRam();
  // Catalog filter / sort state.
  const [query, setQuery] = useState("");
  const [onlyDownloaded, setOnlyDownloaded] = useState(false);
  const [onlyFits, setOnlyFits] = useState(false);
  const [sortBy, setSortBy] = useState<"name" | "size" | "params">("name");

  if (picked) {
    return <LocalModelPane model={picked} onBack={() => setPicked(null)} />;
  }

  // Prefer the full catalog when we have it; otherwise fall back to the
  // locally-present models so the user is never blocked on the network
  // for something already on their disk. EITHER WAY we enrich every
  // entry with a `downloaded` flag derived from the on-disk probe —
  // the network catalog itself has no knowledge of the local user's
  // disk, so without this enrichment the Offload button never appears
  // for any model when the network is up.
  const downloadedIds = new Set((local ?? []).map((m) => m.id));
  const list = (models ?? local)?.map((m) => ({
    ...m,
    downloaded: m.downloaded || downloadedIds.has(m.id),
  }));

  if (!list) {
    return (
      <div className="space-y-3">
        {waiting && <WaitingForNetwork />}
        <div className="space-y-2" aria-busy="true" aria-label="Loading model catalog">
          <ModelRowSkeleton />
          <ModelRowSkeleton />
          <ModelRowSkeleton />
          <ModelRowSkeleton />
        </div>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div className="space-y-3">
        {waiting && <WaitingForNetwork />}
        <EmptyState
          title="No models available yet"
          body={
            waiting
              ? "Waiting for the network catalog. Any models you've already downloaded will appear here even while offline."
              : "The catalog is empty. Connect to the network to browse downloadable models."
          }
        />
      </div>
    );
  }

  const downloadedCount = list.filter((m) => m.downloaded).length;

  // Apply filter + sort.
  const q = query.trim().toLowerCase();
  const filtered = list
    .filter((m) => {
      if (q) {
        const hay = `${m.name} ${m.family} ${m.parameters ?? ""} ${m.quantization ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (onlyDownloaded && !m.downloaded) return false;
      if (onlyFits && hostRamGb && m.min_ram_gb && m.min_ram_gb > hostRamGb) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "size") return (a.size_bytes ?? 0) - (b.size_bytes ?? 0);
      if (sortBy === "params") {
        const pa = parseFloat((a.parameters ?? "0").replace(/[^0-9.]/g, "")) || 0;
        const pb = parseFloat((b.parameters ?? "0").replace(/[^0-9.]/g, "")) || 0;
        return pa - pb;
      }
      return a.name.localeCompare(b.name);
    });

  return (
    <div>
      {waiting && !models && (
        <div className="mb-4">
          <WaitingForNetwork compact />
        </div>
      )}
      {downloadedCount === 0 && hostRamGb && (
        <HardwareRecommendation hostRamGb={hostRamGb} models={list} onPick={setPicked} />
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name / family / quant…"
          className="min-w-[12rem] flex-1 border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:border-foreground"
        />
        <FilterChip
          active={onlyDownloaded}
          onClick={() => setOnlyDownloaded((v) => !v)}
          label="Downloaded"
        />
        <FilterChip
          active={onlyFits}
          onClick={() => setOnlyFits((v) => !v)}
          label="Fits my RAM"
          disabled={!hostRamGb}
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:border-foreground"
        >
          <option value="name">Sort: name</option>
          <option value="size">Sort: size</option>
          <option value="params">Sort: parameters</option>
        </select>
      </div>
      <p className="mb-4 text-xs uppercase tracking-wider text-muted-foreground">
        {filtered.length} of {list.length} model{list.length === 1 ? "" : "s"}
        {downloadedCount > 0 ? ` · ${downloadedCount} downloaded` : ""}
      </p>
      <ul className="space-y-2">
        {filtered.map((m) => (
          <li key={`${m.id}-${refreshTick}`}>
            <ModelRow
              model={m}
              hostRamGb={hostRamGb}
              onPick={() => setPicked(m)}
              onShowDetails={() => setDetailsId(m.id)}
              onOffloaded={() => setRefreshTick((t) => t + 1)}
            />
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="border border-border bg-card p-6 text-sm text-muted-foreground">
            No models match your filter.
          </li>
        )}
      </ul>
      {detailsId && (
        <ModelDetailsModal
          id={detailsId}
          onClose={() => setDetailsId(null)}
          onOffloaded={() => {
            setDetailsId(null);
            setRefreshTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

/** A single model row in the Run-AI-Locally catalog. Chat opens on
 *  click of the body; per-row action buttons (Details, Offload) use
 *  capture-phase stopPropagation so they fire before — not after — the
 *  body's bubbling onClick reaches the row container. Confirmation
 *  uses inline React state (not window.confirm) so WebView-blocked
 *  native dialogs don't silently no-op the button.
 *
 *  Offload requires the model be on disk AND not currently loaded into
 *  the per-model sidecar — the backend enforces both and returns a
 *  friendly error if violated. */
function ModelRow({
  model,
  hostRamGb,
  onPick,
  onShowDetails,
  onOffloaded,
}: {
  model: ModelInfo;
  hostRamGb?: number;
  onPick: () => void;
  onShowDetails: () => void;
  onOffloaded: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "offloading" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [freed, setFreed] = useState<number>(0);

  async function offload() {
    const sizeHint = model.size_bytes
      ? `${(model.size_bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
      : "this model";
    // Native OS confirm dialog (tauri-plugin-dialog). One click,
    // platform-native UX, no WebView blocking. Falls back gracefully
    // if the plugin import fails (dev hot-reload edge case).
    let ok = false;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      ok = await confirm(
        `Free ${sizeHint}? You can re-download this model anytime from the catalog.`,
        { title: `Offload ${model.name}`, kind: "warning" },
      );
    } catch {
      ok = window.confirm(`Offload ${model.name} (${sizeHint})?`);
    }
    if (!ok) return;
    setPhase("offloading");
    setError(null);
    try {
      const f = await invoke<number>("offload_model", { id: model.id });
      setFreed(f);
      setPhase("done");
      try {
        await invoke("sidecar_refresh_models");
      } catch (e) {
        console.warn("sidecar_refresh_models after offload failed:", e);
      }
      setTimeout(() => onOffloaded(), 800);
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  // Capture-phase handlers on action buttons so React fires them
  // BEFORE the body's bubbling onClick reaches the row container.
  const stopAll = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div className="w-full border border-border bg-card transition hover:bg-accent">
      <button
        type="button"
        onClick={onPick}
        className="block w-full p-4 text-left"
      >
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{model.name}</span>
              {model.downloaded && <DownloadedBadge />}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {model.family} · {model.parameters} ·{" "}
              {model.context_length.toLocaleString()} ctx
              {model.quantization ? ` · ${model.quantization}` : ""}
            </div>
          </div>
          <SizeTag bytes={model.size_bytes} minRam={model.min_ram_gb} hostRamGb={hostRamGb} />
        </div>
        {model.description && (
          <p className="mt-2 text-sm text-muted-foreground">
            {model.description}
          </p>
        )}
      </button>
      <div
        className="flex items-center justify-end gap-2 border-t border-border bg-card/60 px-4 py-2"
        // Action bar is outside the chat-open button so clicks here
        // physically cannot reach the chat-open handler.
      >
        {error && (
          <span className="mr-auto text-xs text-destructive">
            {error}
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-2 underline hover:no-underline"
            >
              dismiss
            </button>
          </span>
        )}
        {phase === "done" && (
          <span className="mr-auto text-xs text-emerald-600 dark:text-emerald-400">
            Freed {(freed / 1024 / 1024 / 1024).toFixed(2)} GB
          </span>
        )}
        <button
          type="button"
          onPointerDown={stopAll}
          onClick={(e) => {
            stopAll(e);
            onShowDetails();
          }}
          className="border border-border bg-secondary px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
          title="Show full model details"
        >
          Details
        </button>
        {model.downloaded && phase === "idle" && (
          <button
            type="button"
            onPointerDown={stopAll}
            onClick={(e) => {
              stopAll(e);
              offload();
            }}
            className="border border-amber-600/40 bg-amber-600/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300 hover:bg-amber-600/20"
            title="Remove this model from disk to reclaim space."
          >
            Offload
          </button>
        )}
        {phase === "offloading" && (
          <span className="text-xs text-muted-foreground">Offloading…</span>
        )}
      </div>
    </div>
  );
}

/** Full per-model details modal — backed by the `model_details` Tauri
 *  command which combines catalog metadata + on-disk facts in one
 *  round-trip. Renders as a centred overlay with a single scrollable
 *  body. */
function ModelDetailsModal({
  id,
  onClose,
  onOffloaded,
}: {
  id: string;
  onClose: () => void;
  onOffloaded: () => void;
}) {
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offloading, setOffloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await invoke<any>("model_details", { id });
        if (cancelled) return;
        if (d === null) setError("Model not found in the catalog.");
        else setData(d);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const [confirming, setConfirming] = useState(false);
  const [offloadError, setOffloadError] = useState<string | null>(null);

  async function doOffload() {
    if (!data?.local?.downloaded) return;
    setOffloading(true);
    setOffloadError(null);
    try {
      await invoke<number>("offload_model", { id });
      try {
        await invoke("sidecar_refresh_models");
      } catch (e) {
        console.warn("sidecar_refresh_models after offload failed:", e);
      }
      onOffloaded();
    } catch (e) {
      setOffloadError(String(e));
      setOffloading(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {error && (
          <div className="text-sm text-destructive">
            {error}
            <button
              onClick={onClose}
              className="ml-3 underline hover:no-underline"
            >
              Close
            </button>
          </div>
        )}
        {!data && !error && (
          <div className="text-sm text-muted-foreground">Loading details…</div>
        )}
        {data && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">{data.name}</h2>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {data.id} · {data.family} · {data.architecture}
                </div>
              </div>
              <button
                onClick={onClose}
                className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
            {data.description && (
              <p className="text-sm text-muted-foreground">{data.description}</p>
            )}
            <Section title="Model">
              <KV k="Parameters" v={data.parameters} />
              <KV k="Quantization" v={data.quantization || "—"} />
              <KV k="Context length" v={data.context_length.toLocaleString()} />
              <KV k="Catalog size" v={formatGB(data.catalog_size_bytes)} />
              <KV k="Min RAM" v={data.min_ram_gb ? `${data.min_ram_gb} GB` : "—"} />
              <KV k="License" v={data.license || "—"} />
              <KV k="HF repo" v={data.hf_repo || "—"} mono />
            </Section>
            <Section title="On disk">
              <KV
                k="Downloaded"
                v={data.local.downloaded ? "Yes" : "No"}
                accent={data.local.downloaded ? "good" : "muted"}
              />
              {data.local.downloaded && (
                <>
                  <KV k="Size on disk" v={formatGB(data.local.on_disk_bytes)} />
                  <KV k="Path" v={data.local.on_disk_path || "—"} mono />
                </>
              )}
              {data.mmproj_required && (
                <KV
                  k="Vision projector"
                  v={
                    data.local.mmproj_present
                      ? `Present (${formatGB(data.local.mmproj_bytes)})`
                      : "Missing — vision input will degrade to text-only"
                  }
                  accent={data.local.mmproj_present ? "good" : "warn"}
                />
              )}
              <KV
                k="Loaded in engine"
                v={data.local.loaded_in_sidecar ? "Yes" : "No"}
                accent={data.local.loaded_in_sidecar ? "good" : "muted"}
              />
            </Section>
            <Section title="Runtime — samplers (model-author defaults)">
              <KV k="Temperature" v={data.serving.temperature} />
              <KV k="Top-p" v={data.serving.top_p} />
              <KV k="Top-k" v={data.serving.top_k || "disabled"} />
              <KV k="Min-p" v={data.serving.min_p || "disabled"} />
              <KV
                k="--jinja"
                v={data.serving.jinja_required ? "Required" : "Off"}
              />
            </Section>
            <Section title="Runtime — reasoning policy">
              <KV
                k="Supports thinking"
                v={data.reasoning.supports_thinking ? "Yes" : "No"}
                accent={data.reasoning.supports_thinking ? "good" : "muted"}
              />
              {data.reasoning.supports_thinking && (
                <>
                  <KV k="Default mode" v={data.reasoning.default_mode} />
                  <KV
                    k="Safe min size"
                    v={`${data.reasoning.thinking_safe_min_b}B active`}
                  />
                  <KV
                    k="Safe min budget"
                    v={`${data.reasoning.thinking_min_budget_tokens.toLocaleString()} tokens`}
                  />
                </>
              )}
              <KV
                k="Chat-template fix"
                v={data.template_fix === "vendored" ? "Vendored (client-side fix)" : "None (using GGUF embedded)"}
                accent={data.template_fix === "vendored" ? "good" : "muted"}
              />
            </Section>
            {data.moe && (
              <Section title="Mixture-of-Experts">
                <KV k="Total experts" v={data.moe.num_experts} />
                <KV
                  k="Experts per token"
                  v={data.moe.experts_per_token}
                />
                <KV k="Shared experts" v={data.moe.shared_experts ?? "—"} />
              </Section>
            )}
            {data.mtp_kind && data.mtp_kind !== "none" && (
              <Section title="Speculative decoding">
                <KV k="Type" v={data.mtp_kind} />
                {data.drafter_id && (
                  <KV k="Drafter" v={data.drafter_id} mono />
                )}
              </Section>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              {offloadError && (
                <span className="mr-auto text-xs text-destructive">
                  {offloadError}
                </span>
              )}
              {data.local.downloaded && !confirming && !offloading && (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={data.local.loaded_in_sidecar}
                  className="border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300 hover:bg-amber-600/20 disabled:opacity-50"
                  title={
                    data.local.loaded_in_sidecar
                      ? "Stop the chat first — the model is currently loaded."
                      : "Free disk space by removing this model. Re-download anytime."
                  }
                >
                  Offload ({formatGB(data.local.on_disk_bytes)})
                </button>
              )}
              {confirming && !offloading && (
                <>
                  <span className="mr-auto text-xs text-muted-foreground">
                    Free {formatGB(data.local.on_disk_bytes)}? You can re-download anytime.
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="border border-border bg-secondary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={doOffload}
                    className="border border-amber-600/40 bg-amber-600 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-white hover:bg-amber-700"
                  >
                    Confirm offload
                  </button>
                </>
              )}
              {offloading && (
                <span className="text-xs text-muted-foreground">Offloading…</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function KV({
  k,
  v,
  mono,
  accent,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
  accent?: "good" | "warn" | "muted";
}) {
  const accentClass =
    accent === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "";
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span
        className={`text-right ${accentClass} ${mono ? "break-all font-mono" : ""}`}
      >
        {v}
      </span>
    </div>
  );
}

function formatGB(bytes: number | undefined): string {
  if (!bytes) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb < 0.01) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${gb.toFixed(2)} GB`;
}

function DownloadedBadge() {
  return (
    <span className="border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
      Downloaded
    </span>
  );
}

function SizeTag({
  bytes,
  minRam,
  hostRamGb,
}: {
  bytes?: number;
  minRam?: number;
  hostRamGb?: number;
}) {
  if (!bytes) return null;
  const gb = bytes / 1024 / 1024 / 1024;
  // Fit verdict: red if min_ram exceeds host RAM; amber if it leaves
  // <2 GB headroom; green if comfortable. Falls back to no badge when
  // we don't have either number.
  let fit: { color: string; label: string } | null = null;
  if (hostRamGb && minRam) {
    if (minRam > hostRamGb) {
      fit = { color: "text-destructive", label: "won't fit" };
    } else if (hostRamGb - minRam < 2) {
      fit = { color: "text-amber-600 dark:text-amber-400", label: "tight" };
    } else {
      fit = { color: "text-emerald-600 dark:text-emerald-400", label: "fits" };
    }
  }
  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground">
      <span className="font-mono">{gb.toFixed(2)} GB</span>
      {minRam ? ` · ${minRam} GB RAM` : ""}
      {fit && (
        <>
          {" · "}
          <span className={`font-medium ${fit.color}`}>{fit.label}</span>
        </>
      )}
    </span>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border px-2 py-1 text-xs uppercase tracking-wider transition disabled:opacity-50 ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-secondary text-secondary-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );
}

/** Empty-state hardware-aware first-run recommendation. Picks the
 *  largest model whose min_ram_gb fits the host comfortably (host -
 *  min_ram >= 2 GB) so first-time users don't pick something that
 *  thrashes their machine. Only renders when nothing is downloaded. */
function HardwareRecommendation({
  hostRamGb,
  models,
  onPick,
}: {
  hostRamGb: number;
  models: ModelInfo[];
  onPick: (m: ModelInfo) => void;
}) {
  const fits = models
    .filter((m) => m.min_ram_gb && m.min_ram_gb + 2 <= hostRamGb)
    .sort((a, b) => (b.min_ram_gb ?? 0) - (a.min_ram_gb ?? 0));
  const recommended = fits[0];
  if (!recommended) return null;
  return (
    <div className="mb-4 border border-emerald-600/30 bg-emerald-500/5 p-4">
      <div className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
        Recommended for your hardware
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{recommended.name}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {recommended.family} · {recommended.parameters} ·{" "}
            {recommended.min_ram_gb} GB RAM ·{" "}
            {((recommended.size_bytes ?? 0) / 1024 / 1024 / 1024).toFixed(2)} GB to download
            <br />
            Your machine has <span className="font-mono text-foreground">{hostRamGb} GB</span> RAM —
            this leaves comfortable headroom for the OS and other apps.
          </div>
        </div>
        <button
          type="button"
          onClick={() => onPick(recommended)}
          className="border border-emerald-600/40 bg-emerald-600 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-white hover:bg-emerald-700"
        >
          Start
        </button>
      </div>
    </div>
  );
}

/** Probe the host's RAM once on mount via hardware_profile. Returns
 *  undefined while loading. */
function useHostRam(): number | undefined {
  const [ram, setRam] = useState<number | undefined>();
  useEffect(() => {
    let cancelled = false;
    invoke<{ ram_gb: number }>("hardware_profile")
      .then((p) => { if (!cancelled) setRam(p.ram_gb); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);
  return ram;
}

type LocalState =
  | { kind: "idle" }
  | { kind: "downloading"; progress: DownloadProgress }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function LocalModelPane({
  model,
  onBack,
}: {
  model: ModelInfo;
  onBack: () => void;
}) {
  // If the model is already downloaded, jump straight into loading on
  // mount — the user doesn't need to click Download for something they
  // already have. The serve_model RPC is idempotent on already-loaded
  // models, so this also covers the case where the runtime already has
  // it (just snaps to ready).
  const [state, setState] = useState<LocalState>(
    model.downloaded ? { kind: "loading" } : { kind: "idle" },
  );
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // Sidecar (inference engine) readiness — independent of the node.
  const { ready: engineReady, loading: engineLoading } = useSidecarReady();
  // A message the user submitted before the engine was ready. We hold
  // it here and auto-dispatch once `engineReady` flips true, instead of
  // erroring on a not-yet-ready sidecar.
  const [queued, setQueued] = useState<string | null>(null);
  // Conversation persistence. `conversationId` is created lazily on the
  // first user message so an opened-but-never-used chat doesn't litter
  // the sidebar. Save points: user message on dispatch; assistant
  // message on stream finalise.
  const conversationId = useRef<string | null>(null);
  // Incremented after every persisted message so the ConversationSidebar
  // re-fetches the list.
  const [historyTick, setHistoryTick] = useState(0);
  const bumpHistory = () => setHistoryTick((t) => t + 1);

  // Bumped on every chat-switch so the stream-subscriber effect re-runs.
  const [streamTick, setStreamTick] = useState(0);
  const bumpStream = () => setStreamTick((t) => t + 1);

  // Subscribe to the active stream (if any) for whichever conversation
  // is currently visible. On each delta the subscriber syncs the
  // visible `messages` state to the registry's buffer, so a chat the
  // user revisits keeps painting live tokens.
  useEffect(() => {
    const id = conversationId.current;
    if (!id) return;
    const unsub = subscribeStream(id, () => {
      const live = getActiveStream(id);
      if (!live) return;
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            content: live.content,
            streaming: !live.done,
            stats: live.stats,
          };
        }
        return next;
      });
      if (live.done) setSending(false);
    });
    return unsub;
  }, [streamTick]);

  // Sidebar: load an existing conversation's messages into the pane.
  // Does NOT cancel an in-flight stream — the model keeps generating
  // into the original chat in the background. If the *new* chat has
  // its own stream running, we splice the live content into the
  // loaded SQL history.
  async function loadConversation(id: string) {
    try {
      const { loadMessages } = await import("../lib/conversations");
      const rows = await loadMessages(id);
      const loaded: ChatMsg[] = rows.map((r) => ({
        role: r.role as ChatMsg["role"],
        content: r.content,
        streaming: false,
        stats: r.stats_json ? safeParseStats(r.stats_json) : undefined,
      }));
      const live = getActiveStream(id);
      if (live && !live.done) {
        // Replace the last assistant row (if it's the partial-saved
        // placeholder) with a live-streaming row that the subscriber
        // effect will keep up-to-date.
        const last = loaded[loaded.length - 1];
        if (last && last.role === "assistant") {
          loaded[loaded.length - 1] = {
            ...last,
            content: live.content,
            streaming: true,
            stats: live.stats,
          };
        } else {
          loaded.push({ role: "assistant", content: live.content, streaming: true, stats: live.stats });
        }
      }
      setMessages(loaded);
      conversationId.current = id;
      setChatError(null);
      // The new chat is in-flight if there's a live stream for it.
      setSending(!!(live && !live.done));
      bumpStream(); // re-run the subscribe effect for the new id
    } catch (e) {
      console.warn("loadConversation failed:", e);
    }
  }

  // Sidebar: start a brand-new chat. Clears the messages + drops the
  // conversation id so the next dispatch creates a fresh row. Does NOT
  // cancel an in-flight stream — that one keeps writing into its own
  // conversation row in the background.
  function startNewChat() {
    setMessages([]);
    conversationId.current = null;
    setChatError(null);
    setSending(false);
    bumpStream();
  }

  // Cmd-N (native menu) starts a new chat in the current pane.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u = await listen<string>("menu-event", (ev) => {
          if (ev.payload === "new_chat") startNewChat();
        });
        unlisten = u;
      } catch { /* ignore */ }
    })();
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fork from message N: copy messages[0..=N] into a brand-new
  // conversation row (so the original is preserved) + load it. The
  // next user turn extends the fork — original untouched.
  async function forkAt(index: number) {
    try {
      const slice = messages.slice(0, index + 1);
      const { createConversation, appendMessage, deriveTitle } = await import("../lib/conversations");
      const firstUserMsg = slice.find((m) => m.role === "user")?.content ?? "";
      const newId = await createConversation({
        modelId: model.id,
        title: `Fork: ${deriveTitle(firstUserMsg)}`,
      });
      for (const m of slice) {
        await appendMessage({
          conversationId: newId,
          role: m.role,
          content: m.content,
          stats: m.stats,
        });
      }
      conversationId.current = newId;
      setMessages(slice.map((m) => ({ ...m, streaming: false })));
      setChatError(null);
      bumpHistory();
      toast.success("Forked into a new chat");
    } catch (e) {
      console.warn("fork failed:", e);
      toast.error("Fork failed");
    }
  }

  // On mount / on model change: figure out the current state and, if
  // the model is on-disk, pre-load it into the sidecar's KV cache so
  // the first chat doesn't pay cold-start latency. On unmount, unload
  // to free the RAM/VRAM.
  //
  // Three on-mount paths:
  //  1. A download is in flight for this model → resume the polling UI.
  //  2. The file is fully on disk → trigger an explicit `sidecar_load_model`
  //     and show "Loading…" until it succeeds, then go to `ready`.
  //  3. Neither → idle.
  //
  // `tenzro_getDownloadProgress` *errors* (code -32000) when no entry
  // exists for the model — treat that as "not downloading" rather than
  // surfacing it as an error.
  useEffect(() => {
    let cancelled = false;
    let loadedPath: string | null = null;
    (async () => {
      try {
        const progress = await rpc<DownloadProgress>(
          "tenzro_getDownloadProgress",
          [{ model_id: model.id }],
        );
        if (cancelled) return;
        if (progress.status === "in_progress" || progress.status === "queued" || progress.status === "pending") {
          setState({ kind: "downloading", progress });
          return;
        }
        if (progress.status === "completed") {
          // fall through to the load step below
        }
      } catch { /* no in-flight entry — fall through */ }
      try {
        const details = await invoke<{
          local?: { downloaded?: boolean; on_disk_path?: string | null };
        }>("model_details", { id: model.id }).catch(() => null);
        if (cancelled) return;
        const downloaded = details?.local
          ? !!details.local.downloaded
          : model.downloaded;
        if (!downloaded) return; // idle — user clicks Download
        // The sidecar router (llama-server) auto-loads the GGUF on the
        // first chat request via `--models-dir` scanning. There is no
        // explicit pre-load step — earlier attempts hit a non-existent
        // `/models/load` endpoint and hung. Going straight to "ready"
        // is correct: the first chat turn pays the cold-start cost,
        // and the streaming UI's "Loading model into memory…" engine
        // hint already surfaces that wait inline.
        loadedPath = details?.local?.on_disk_path ?? null;
        setState({ kind: "ready" });
      } catch (e) {
        console.warn("model state probe failed:", e);
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
      // Unload from the sidecar to free memory when the user leaves
      // this model's pane. Best-effort — we don't block the unmount on
      // a network round-trip + don't surface the result.
      if (loadedPath || model.downloaded) {
        invoke("sidecar_unload_model", { args: { model_id: model.id } })
          .catch((e) => console.warn("sidecar_unload_model on exit:", e));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id]);

  // Poll download progress while downloading.
  useEffect(() => {
    if (state.kind !== "downloading") return;
    const id = setInterval(async () => {
      try {
        const progress = await rpc<DownloadProgress>(
          "tenzro_getDownloadProgress",
          [{ model_id: model.id }],
        );
        if (progress.status === "completed") {
          // Download done. The llama-server router only scans its
          // models-dir at boot, so a model that just finished
          // downloading is invisible until we restart the sidecar.
          // Refresh (restart + re-scan) BEFORE going ready so the first
          // chat doesn't 400 "model not found". refreshSidecarModels
          // swallows its own errors — the chat-time 400 backstop is the
          // safety net if this restart is slow or fails.
          await refreshSidecarModels();
          setState({ kind: "ready" });
        } else if (progress.status === "failed") {
          setState({
            kind: "error",
            message: progress.error ?? "Download failed",
          });
        } else if (progress.status === "cancelled") {
          setState({ kind: "idle" });
        } else {
          setState({ kind: "downloading", progress });
        }
      } catch (e) {
        setState({ kind: "error", message: String(e) });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [state.kind, model.id]);

  async function cancelDownload() {
    try {
      await rpc("tenzro_cancelDownload", [{ model_id: model.id }]);
      setState({ kind: "idle" });
    } catch (e) {
      // Even if the RPC fails, drop back to idle so the user isn't stuck.
      console.warn("cancelDownload failed:", e);
      setState({ kind: "idle" });
    }
  }

  async function startDownload() {
    try {
      await rpc("tenzro_downloadModel", [{ model_id: model.id }]);
      setState({
        kind: "downloading",
        progress: { model_id: model.id, status: "in_progress" },
      });
    } catch (e) {
      // If the model is already downloaded, the sidecar will auto-
      // load it on first chat. Skip the load step and go straight
      // to ready.
      const msg = String(e);
      if (msg.toLowerCase().includes("already")) {
        setState({ kind: "ready" });
      } else {
        setState({ kind: "error", message: msg });
      }
    }
  }

  // Current in-flight request id for cancellation. A ref (not state)
  // so the Stop button can dispatch without re-renders triggering
  // stale-closure bugs.
  const inflightId = useRef<string | null>(null);

  /** Run a single chat stream against the sidecar, mutating the
   *  trailing assistant placeholder in `messages`. Shared between
   *  `sendChat` (new user message) and `regenerateLast` (drop the
   *  prior assistant turn and retry) so the throttling, channel
   *  plumbing, and stats commit logic stay in one place.
   *
   *  Token deltas are buffered and flushed on a 33 ms (~30 fps)
   *  timer rather than per `requestAnimationFrame` tick. Two
   *  reasons:
   *
   *  1. WKWebView on a ProMotion display ticks rAF at up to 120 Hz;
   *     committing four React renders per native compositor frame is
   *     pure overhead and amplified the whole-screen flicker we hit on
   *     M-series GPUs.
   *  2. 30 fps is enough for streaming chat — the eye does not notice
   *     token-level latency above that threshold; the GPU very much
   *     does.
   */
  async function runStream(history: ChatMsg[]) {
    setSending(true);
    setChatError(null);

    // Snapshot the conversation id at stream start. Switching chats
    // mid-stream changes `conversationId.current`, but THIS stream
    // belongs to whatever was active when the user pressed Send.
    const streamConvId = conversationId.current;
    if (!streamConvId) {
      // No conversation row yet (shouldn't happen — dispatch creates it
      // before runStream) — fall back to inline-only mode.
      console.warn("runStream: no conversation id; persistence disabled");
    }

    // Register this stream so a chat-switch doesn't orphan it.
    const stream: ActiveStream | null = streamConvId
      ? {
          conversationId: streamConvId,
          modelId: model.id,
          content: "",
          stats: {},
          done: false,
          error: null,
          subscribers: new Set(),
        }
      : null;
    if (stream) ACTIVE_STREAMS.set(streamConvId!, stream);

    let pending: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_INTERVAL_MS = 33;
    let buf = "";
    const flush = () => {
      pending = null;
      if (!buf) return;
      const chunk = buf;
      buf = "";
      if (stream) {
        stream.content += chunk;
        notifyStream(stream);
      }
      // Also update the displayed messages, but ONLY if the user is
      // still viewing this conversation (or no conversation — e.g. a
      // first-message stream before the row was registered).
      if (!streamConvId || conversationId.current === streamConvId) {
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, content: last.content + chunk };
          }
          return next;
        });
      }
    };
    const scheduleFlush = () => {
      if (pending == null) {
        pending = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
    };

    // Periodic partial-save to SQL so a crash mid-stream doesn't lose
    // history. We write a placeholder assistant row on first delta, then
    // update its content every 2s. Final stats land in the `finally`.
    let partialMsgId: number | null = null;
    let partialSaveTimer: ReturnType<typeof setInterval> | null = null;
    const saveModule = streamConvId ? import("../lib/conversations") : null;
    if (streamConvId && saveModule) {
      partialSaveTimer = setInterval(async () => {
        if (!stream || stream.content.length === 0) return;
        try {
          const mod = await saveModule;
          if (partialMsgId == null) {
            // Append a placeholder; remember its id for subsequent updates.
            // appendMessage doesn't return the id, so we INSERT directly
            // by re-calling the lib via a slimmer helper. For now, just
            // append once and rely on the `finally` to replace it via
            // updateMessage; but appendMessage doesn't expose the id either.
            // Compromise: append once, mark the id by reading back the
            // most-recent assistant message for this convo.
            await mod.appendMessage({
              conversationId: streamConvId,
              role: "assistant",
              content: stream.content,
            });
            const rows = await mod.loadMessages(streamConvId);
            const last = rows[rows.length - 1];
            if (last && last.role === "assistant") {
              partialMsgId = last.id;
            }
          } else {
            await mod.updateMessage({
              messageId: partialMsgId,
              content: stream.content,
            });
          }
        } catch (e) {
          console.warn("partial save failed:", e);
        }
      }, 2000);
    }

    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random()}`;
    inflightId.current = requestId;

    const onEvent = new Channel<ChatEvent>();
    onEvent.onmessage = (evt) => {
      switch (evt.kind) {
        case "started":
          if (stream) stream.stats = { ...stream.stats, ttft_ms: evt.ttft_ms };
          break;
        case "delta":
          buf += evt.content;
          scheduleFlush();
          break;
        case "usage":
          if (stream) {
            stream.stats = {
              ...stream.stats,
              prompt_tokens: evt.prompt_tokens,
              completion_tokens: evt.completion_tokens,
              tok_per_sec: evt.tok_per_sec,
            };
          }
          break;
        case "done":
          if (stream) stream.stats = { ...stream.stats, finish_reason: evt.finish_reason };
          break;
        case "error":
          if (stream) stream.error = evt.message;
          // Only surface to the visible UI if we're still on this chat.
          if (!streamConvId || conversationId.current === streamConvId) {
            setChatError(evt.message);
          }
          break;
      }
    };

    try {
      await invoke("sidecar_chat_stream", {
        args: {
          request_id: requestId,
          body: {
            model: model.id,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          },
        },
        onEvent,
      });
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("cancelled")) {
        console.error(`[sidecar_chat_stream] ${model.id} failed:`, e);
        if (stream) stream.error = msg;
        if (!streamConvId || conversationId.current === streamConvId) {
          setChatError(msg);
        }
      }
    } finally {
      if (pending != null) {
        clearTimeout(pending);
        pending = null;
      }
      flush();
      if (partialSaveTimer != null) {
        clearInterval(partialSaveTimer);
        partialSaveTimer = null;
      }

      const finalContent = stream ? stream.content : "";
      const finalStats = stream ? stream.stats : {};
      if (stream) {
        stream.done = true;
        notifyStream(stream);
      }

      // Update the displayed messages if the user is still on this chat.
      if (!streamConvId || conversationId.current === streamConvId) {
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, stats: finalStats, streaming: false };
          }
          return next;
        });
      }

      // Persist the assistant message. If we saved a partial row, update
      // it with the final content + stats; otherwise append once.
      if (streamConvId && finalContent && saveModule) {
        try {
          const mod = await saveModule;
          if (partialMsgId != null) {
            await mod.updateMessage({
              messageId: partialMsgId,
              content: finalContent,
              stats: finalStats,
            });
          } else {
            await mod.appendMessage({
              conversationId: streamConvId,
              role: "assistant",
              content: finalContent,
              stats: finalStats,
            });
          }
          bumpHistory();
        } catch (e) {
          console.warn("conversation persistence (assistant msg) failed:", e);
        }
      }

      if (stream) ACTIVE_STREAMS.delete(streamConvId!);
      inflightId.current = null;
      // Only flip the spinner if the visible chat is the one that just
      // finished — otherwise the user is on a different chat and the
      // input bar shouldn't suddenly unlock.
      if (!streamConvId || conversationId.current === streamConvId) {
        setSending(false);
      }
    }
  }

  /** Append a user message + an assistant placeholder and stream the
   *  reply. The placeholder content reflects whether we're actually
   *  streaming or still waiting for the engine. Also creates a
   *  conversation row on the first send + persists the user message. */
  async function dispatch(text: string, waitingForEngine: boolean) {
    const userMsg: ChatMsg = { role: "user", content: text };
    const baseHistory = [...messages, userMsg];
    setMessages([...baseHistory, { role: "assistant", content: "", streaming: true }]);
    // Conversation row: create lazily on first user message.
    try {
      const { createConversation, appendMessage, deriveTitle } = await import("../lib/conversations");
      if (!conversationId.current) {
        const id = await createConversation({
          modelId: model.id,
          title: deriveTitle(text),
        });
        conversationId.current = id;
        bumpHistory();
      }
      await appendMessage({
        conversationId: conversationId.current,
        role: "user",
        content: text,
      });
    } catch (e) {
      console.warn("conversation persistence (user msg) failed:", e);
    }
    if (waitingForEngine) {
      // Don't start the stream yet — the queue-flush effect will run it
      // once the sidecar reports ready.
      return baseHistory;
    }
    await runStream(baseHistory);
    return baseHistory;
  }

  async function sendChat() {
    if (!input.trim() || sending || queued) return;
    const text = input;
    setInput("");
    if (!engineReady) {
      // Engine still spinning up — queue the message and show a waiting
      // assistant bubble. The flush effect dispatches it when ready.
      setQueued(text);
      await dispatch(text, true);
      return;
    }
    await dispatch(text, false);
  }

  // Flush a queued message once the engine becomes ready. The assistant
  // placeholder is already in `messages`; we just need to run the stream
  // against the history up to and including the queued user turn.
  useEffect(() => {
    if (!queued || !engineReady) return;
    let cancelled = false;
    (async () => {
      // History excludes the trailing assistant placeholder.
      const baseHistory = messages.filter(
        (_, i) => !(i === messages.length - 1 && messages[i].role === "assistant"),
      );
      setQueued(null);
      if (!cancelled) await runStream(baseHistory);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, engineReady]);

  async function cancelChat() {
    const id = inflightId.current;
    if (!id) return;
    try {
      await invoke("sidecar_chat_cancel", { args: { request_id: id } });
    } catch (e) {
      console.warn("sidecar_chat_cancel failed:", e);
    }
  }

  /** Drop the trailing assistant message and re-run the stream
   *  against the same user history (no new user message added). */
  async function regenerateLast() {
    if (sending) return;
    let cutMessages: ChatMsg[] = [];
    setMessages((prev) => {
      let cut = prev.length;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "user") {
          cut = i + 1;
          break;
        }
      }
      cutMessages = prev.slice(0, cut);
      return [...cutMessages, { role: "assistant", content: "", streaming: true }];
    });
    await runStream(cutMessages);
  }

  return (
    <div>
      <BackBtn onClick={onBack} label="← Back to catalog" />
      <ModelHeader model={model} />

      {state.kind === "idle" && (
        <div className="mt-8 border border-border bg-card p-6">
          <p className="text-sm">
            Download {model.name} to your machine and chat with it locally.
            {model.size_bytes && (
              <>
                {" "}
                <span className="font-mono text-muted-foreground">
                  ({(model.size_bytes / 1024 / 1024 / 1024).toFixed(2)} GB)
                </span>
              </>
            )}
          </p>
          <button
            onClick={startDownload}
            className="mt-6 border border-border bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Download
          </button>
        </div>
      )}

      {state.kind === "downloading" && (
        <div className="mt-8 border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium">Downloading {model.name}…</p>
            <button
              onClick={cancelDownload}
              className="border border-border bg-secondary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
            >
              Cancel
            </button>
          </div>
          <ProgressBar
            pct={state.progress.progress_percent ?? 0}
            downloaded={state.progress.downloaded_bytes}
            total={state.progress.total_bytes}
          />
        </div>
      )}

      {state.kind === "loading" && (
        <div className="mt-8 border border-border bg-card p-6">
          <p className="text-sm">Loading {model.name} into memory…</p>
        </div>
      )}

      {state.kind === "error" && (
        <ErrorBox title="Something went wrong.">{state.message}</ErrorBox>
      )}

      {state.kind === "ready" && (
        <div className="mt-4 flex items-stretch border border-border bg-card">
          <ConversationSidebar
            modelId={model.id}
            activeId={conversationId.current}
            onSelect={loadConversation}
            onNew={startNewChat}
            refreshKey={historyTick}
          />
          <div className="min-w-0 flex-1">
        <ChatBox
          messages={messages}
          input={input}
          setInput={setInput}
          sending={sending || !!queued}
          error={chatError}
          onSend={sendChat}
          onCancel={cancelChat}
          onRegenerate={regenerateLast}
          onForkAt={forkAt}
          placeholder={`Message ${model.name}…`}
          engineHint={
            queued
              ? "Waiting for the model to be ready — your message will send automatically…"
              : !engineReady
                ? engineLoading
                  ? "Loading model into memory…"
                  : "Starting AI engine…"
                : undefined
          }
        />
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressBar({
  pct,
  downloaded,
  total,
}: {
  pct: number;
  downloaded?: number;
  total?: number;
}) {
  const safe = Math.min(100, Math.max(0, pct));
  return (
    <div className="mt-4">
      <div className="h-2 w-full overflow-hidden border border-border bg-secondary">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${safe}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{safe.toFixed(1)}%</span>
        {downloaded != null && total != null && (
          <span className="font-mono">
            {(downloaded / 1024 / 1024).toFixed(1)} /{" "}
            {(total / 1024 / 1024).toFixed(1)} MB
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Shared components                                                       */
/* --------------------------------------------------------------------- */

function BackBtn({ onClick, label = "← Back" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="mb-4 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
    >
      {label}
    </button>
  );
}

function ModelHeader({ model, extra }: { model: ModelInfo; extra?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-4">
      <div>
        <h3 className="text-base font-medium">{model.name}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {model.family} · {model.parameters} ·{" "}
          {model.context_length.toLocaleString()} ctx
          {extra ? ` · ${extra}` : ""}
        </p>
      </div>
      <PricingTag pricing={model.pricing} />
    </div>
  );
}

function ChatBox({
  messages,
  input,
  setInput,
  sending,
  error,
  onSend,
  onCancel,
  onRegenerate,
  onForkAt,
  placeholder,
  engineHint,
}: {
  messages: ChatMsg[];
  input: string;
  setInput: (s: string) => void;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  /** When omitted, no Stop button is shown (e.g. remote-provider
   *  chat without cancel support yet). */
  onCancel?: () => void;
  /** When omitted, the per-message Regenerate affordance is hidden. */
  onRegenerate?: () => void;
  /** Branch a new chat from message index N. When omitted, Fork is
   *  hidden. */
  onForkAt?: (index: number) => void;
  placeholder: string;
  /** Non-fatal status shown while the inference engine is still
   *  spinning up (starting / loading model / queued send). */
  engineHint?: string;
}) {
  // Auto-scroll with sticky pin-to-bottom: stay glued to the bottom
  // while streaming, release if the user scrolls up.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const slack = 24; // px
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  }

  return (
    <div className="mt-6 flex h-[55vh] flex-col border border-border bg-card">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 space-y-6 overflow-y-auto p-6"
        role="log"
        aria-live="polite"
        aria-label="Chat transcript"
      >
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">{placeholder}</p>
        )}
        {messages.map((m, i) => (
          <ChatMessageRow
            key={i}
            msg={m}
            onRegenerate={
              i === messages.length - 1 && m.role === "assistant" && !m.streaming
                ? onRegenerate
                : undefined
            }
            onFork={onForkAt ? () => onForkAt(i) : undefined}
          />
        ))}
        {error && <div className="text-sm text-destructive">{error}</div>}
      </div>
      <div className="border-t border-border p-3">
        {engineHint && (
          <div className="mb-2 flex items-center gap-2 px-1 text-xs text-amber-600 dark:text-amber-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            {engineHint}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            disabled={sending}
            aria-label="Chat message"
            onKeyDown={(e) => {
              if (e.key === "Escape" && sending && onCancel) {
                e.preventDefault();
                onCancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!sending && input.trim()) onSend();
              }
            }}
          />
          {sending && onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="border border-border bg-secondary px-3 py-2 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="border border-border bg-primary px-3 py-2 text-xs font-medium uppercase tracking-wider text-primary-foreground disabled:opacity-40"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function ChatMessageRow({
  msg,
  onRegenerate,
  onFork,
}: {
  msg: ChatMsg;
  onRegenerate?: () => void;
  onFork?: () => void;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(msg.content);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  }

  const isAssistant = msg.role === "assistant";

  return (
    <div className="group text-sm">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {msg.role}
          </span>
          {msg.streaming && (
            <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
              streaming
            </span>
          )}
        </div>
        {/* Hover-only affordances — Linear / ChatGPT pattern. Visible
          * only on row hover so the chat stays quiet. */}
        <div className="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={copy}
            className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            aria-label="Copy message"
          >
            Copy
          </button>
          {onFork && !msg.streaming && (
            <button
              onClick={onFork}
              className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              aria-label="Fork from here"
              title="Branch a new chat from this point"
            >
              Fork
            </button>
          )}
          {isAssistant && onRegenerate && !msg.streaming && (
            <button
              onClick={onRegenerate}
              className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              aria-label="Regenerate response"
            >
              Regenerate
            </button>
          )}
        </div>
      </div>
      {isAssistant ? (
        msg.streaming && msg.content === "" ? (
          <div className="text-muted-foreground">…</div>
        ) : (
          <Markdown streaming={msg.streaming}>{msg.content}</Markdown>
        )
      ) : (
        <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
      )}
      {msg.stats && (msg.stats.tok_per_sec || msg.stats.ttft_ms) && (
        <div className="mt-2 flex gap-3 font-mono text-[10px] text-muted-foreground">
          {msg.stats.tok_per_sec != null && (
            <span>{msg.stats.tok_per_sec.toFixed(1)} tok/s</span>
          )}
          {msg.stats.ttft_ms != null && (
            <span>· {msg.stats.ttft_ms}ms TTFT</span>
          )}
          {msg.stats.completion_tokens != null && (
            <span>· {msg.stats.completion_tokens} tok</span>
          )}
          {msg.stats.finish_reason && msg.stats.finish_reason !== "stop" && (
            <span>· {msg.stats.finish_reason}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Gate three of the four flows (Use Network, Serve, Validate) behind
 *  a wallet existing. Local AI is the only no-wallet flow.
 *  Renders a create-wallet CTA inline when no wallet exists yet. */
function RequireWallet({
  children,
  reason,
}: {
  children: React.ReactNode;
  reason: string;
}) {
  const { status, refresh } = useWallet();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      // Step 1: device-side passkey ceremony — mints a P-256 keypair
      // in the platform secure enclave (macOS Secure Enclave / Windows
      // Hello / Linux libsecret), gated by the platform biometric
      // prompt. The private key never leaves the enclave; we receive
      // only the public SEC1 `x ‖ y` bytes.
      const label = `tenzro-wallet-${Date.now()}`;
      // Mint a biometry-gated P-256 key in the Secure Enclave. Note:
      // key *generation* does NOT trigger Touch ID on macOS — only key
      // *use* (signing) does.
      // Mints the P-256 enclave key AND seals an ML-DSA-65 post-quantum
      // companion seed to it, returning both public keys + the credential
      // id. Neither generation nor sealing triggers Touch ID.
      const dk = await invoke<DeviceKeyInfo>(
        "device_create_passkey",
        { label },
      );
      // Force the user-presence ceremony: sign a fixed enrollment
      // challenge with the freshly-minted key. This is what pops Touch
      // ID and proves the user controls the enclave key before we bind
      // it to the wallet. Throws if the user cancels the prompt.
      const challenge =
        "0000000000000000000000000000000000000000000000000000000000000001";
      await signPrehashWithPasskey({ label, prehashHex: challenge });
      // On-chain enrollment: registers a TDIP identity, CREATE2-deploys the
      // smart account, and installs the WebAuthnValidator with the hybrid
      // P-256 + ML-DSA-65 custody key. Persists locally and gossips on sync.
      const enrolled = await enrollPasskey(dk, label);
      // Provision the local MPC wallet on the embedded node. Future signing
      // flows use `device_sign_hybrid_with_passkey` for both custody legs.
      await invoke<WalletStatus>("wallet_create");
      console.info(
        "Wallet created with device-bound passkey",
        label,
        dk.public_key_hex.slice(0, 16) + "…",
        "→",
        enrolled.smart_account_address,
      );
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  if (!status) {
    return (
      <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading wallet…
      </div>
    );
  }
  if (!status.node_ready) {
    return (
      <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
        Waiting for the embedded node to start before checking your wallet…
      </div>
    );
  }
  if (!status.exists) {
    return (
      <div className="border border-border bg-card p-6">
        <h3 className="text-sm font-semibold">Wallet required</h3>
        <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          Your wallet is created locally and the keystore never leaves
          your machine. On testnet you'll be credited 10,000 TNZO so
          you have enough to use the network straight away.
        </p>
        {error && (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        )}
        <div className="mt-4">
          <button
            type="button"
            onClick={create}
            disabled={creating}
            className="border border-emerald-600/40 bg-emerald-600 px-4 py-2 text-xs font-medium uppercase tracking-wider text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {creating ? "Creating wallet…" : "Create wallet"}
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

/** Minimal Serve flow: pick a downloaded model and advertise it to the
 *  network as a provider. Uses tenzro_serveModel + tenzro_registerProvider
 *  via the existing rpc_call bridge. */
type ServeVisibility = "network" | "private";
type ServeOptions = { forceSingle?: boolean; userForced?: boolean; visibility?: ServeVisibility };

type ClusterPreview = {
  fit: "RunLocal" | "ClusterRequired" | "ClusterForced";
  forms_cluster: boolean;
  force_single: boolean;
  user_forced: boolean;
  single_box_fit: string | null;
  model_shape: { layers: number; hidden_dim: number; total_vram_gb: number };
  members: {
    address: string;
    vram_gb: number;
    backend: string;
    cap_key: string;
    reachability: string;
    is_head: boolean;
  }[];
  rejected: { address: string; reason: ClusterRejectReason }[];
  stages: { address: string; start_layer: number; end_layer: number; tensor_split: number }[];
  activation_bytes_per_token: number;
};
type ClusterRejectReason =
  | { kind: "commit_mismatch"; expected: string; found: string }
  | { kind: "not_data_plane_reachable"; reachability: string }
  | { kind: "insufficient_vram"; offered_gb: number; needed_gb: number };

function shortAddr(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length <= 10) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function rejectLabel(r: ClusterRejectReason): string {
  switch (r.kind) {
    case "commit_mismatch":
      return `build mismatch (runs ${r.found.slice(0, 7)}, cluster needs ${r.expected.slice(0, 7)})`;
    case "not_data_plane_reachable":
      return `not directly reachable (${r.reachability.replace(/_/g, " ")})`;
    case "insufficient_vram":
      return `too little memory (${r.offered_gb.toFixed(1)} GB, needs ≥ ${r.needed_gb.toFixed(2)} GB)`;
  }
}

function reachLabel(r: string): string {
  switch (r) {
    case "local_direct": return "LAN";
    case "direct": return "direct";
    case "relay_only": return "relay";
    case "symmetric_nat": return "NAT";
    default: return r;
  }
}

// Assisted cluster setup. Fetches the node's dry-run plan for one model and
// lets the operator confirm or override it before serving. Shows the fit
// decision, discovered members, the proposed VRAM-weighted layer split, and
// any rejected members with the reason.
function ClusterPreviewPanel({
  modelId,
  busy,
  onServe,
}: {
  modelId: string;
  busy: boolean;
  onServe: (opts: ServeOptions) => void;
}) {
  const [preview, setPreview] = useState<ClusterPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceCluster, setForceCluster] = useState(false);
  const [forceSingle, setForceSingle] = useState(false);
  const [visibility, setVisibility] = useState<ServeVisibility>("network");

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    const load = async () => {
      try {
        const resp = await invoke<any>("rpc_call", {
          args: {
            method: "tenzro_clusterPreview",
            params: { model_id: modelId, user_forced: forceCluster, force_single: forceSingle },
          },
        });
        if (cancelled) return;
        if (resp?.error) { setError(resp.error.message ?? "preview failed"); return; }
        setPreview(resp?.result ?? null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    load();
    return () => { cancelled = true; };
  }, [modelId, forceCluster, forceSingle]);

  const addrName = (addr: string, isHead: boolean) =>
    isHead ? "This machine" : shortAddr(addr);

  if (error) {
    return (
      <div className="border-t border-border p-4 text-xs text-muted-foreground">
        Couldn’t plan a cluster for this model: <span className="text-destructive">{error}</span>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="border-t border-border p-4 text-xs text-muted-foreground">
        Inspecting hardware and discovering members…
      </div>
    );
  }

  const headByAddr = new Map(preview.members.map((m) => [m.address, m.is_head]));
  const memberByAddr = new Map(preview.members.map((m) => [m.address, m]));
  const fitsLocally = preview.single_box_fit != null;
  const willCluster = preview.forms_cluster;

  return (
    <div className="space-y-4 border-t border-border p-4">
      {/* Fit verdict + model shape. */}
      <div>
        <div className="tnz-eyebrow">Placement</div>
        <p className="mt-1 text-sm">
          {preview.fit === "RunLocal" && (
            <>Fits on <span className="font-medium">this machine</span> — no cluster needed. Serving as a single node is faster.</>
          )}
          {preview.fit === "ClusterRequired" && (
            <>Too large for any single member. It will be <span className="font-medium">split across {preview.stages.length} machines</span>.</>
          )}
          {preview.fit === "ClusterForced" && (
            <>Fits locally, but you chose to <span className="font-medium">split across {preview.stages.length} machines</span>.</>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {preview.model_shape.layers} layers · {preview.model_shape.total_vram_gb.toFixed(1)} GB ·{" "}
          {(preview.activation_bytes_per_token / 1024).toFixed(1)} KB/token across boundaries
        </p>
      </div>

      {/* Discovered members. */}
      <div>
        <div className="tnz-eyebrow">Discovered members ({preview.members.length})</div>
        <ul className="mt-2 grid grid-cols-1 gap-px border border-border bg-border">
          {preview.members.map((m) => (
            <li key={m.address} className="flex items-center justify-between gap-3 bg-card px-3 py-2 text-xs">
              <span className="flex items-center gap-2">
                <span className="font-medium">{addrName(m.address, m.is_head)}</span>
                {m.is_head && (
                  <span className="border border-border px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">head</span>
                )}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {m.vram_gb.toFixed(1)} GB · {m.backend} · {reachLabel(m.reachability)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Proposed layer split (only when a cluster forms). */}
      {willCluster && preview.stages.length > 0 && (
        <div>
          <div className="tnz-eyebrow">Proposed layer split</div>
          <ul className="mt-2 space-y-1">
            {preview.stages.map((s, i) => {
              const m = memberByAddr.get(s.address);
              const span = s.end_layer - s.start_layer;
              const pct = (span / preview.model_shape.layers) * 100;
              return (
                <li key={s.address} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {i + 1}. {addrName(s.address, headByAddr.get(s.address) ?? false)}
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      layers {s.start_layer}–{s.end_layer - 1} ({span})
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full bg-secondary">
                    <div className="h-1" style={{ width: `${pct}%`, background: "var(--brand)" }} />
                  </div>
                  {m && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {m.backend} · {m.vram_gb.toFixed(1)} GB · {reachLabel(m.reachability)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Rejected members. */}
      {preview.rejected.length > 0 && (
        <div>
          <div className="tnz-eyebrow">Not eligible ({preview.rejected.length})</div>
          <ul className="mt-2 space-y-1">
            {preview.rejected.map((r) => (
              <li key={r.address} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/70">{shortAddr(r.address)}</span>
                <span>{rejectLabel(r.reason)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Overrides. */}
      <div className="space-y-2">
        <div className="tnz-eyebrow">Options</div>
        {fitsLocally && !forceSingle && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={forceCluster}
              onChange={(e) => setForceCluster(e.target.checked)}
              className="accent-[#6b79aa]"
            />
            <span>Split across the cluster anyway (slower, but frees memory on this machine)</span>
          </label>
        )}
        {willCluster && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={forceSingle}
              onChange={(e) => { setForceSingle(e.target.checked); if (e.target.checked) setForceCluster(false); }}
              className="accent-[#6b79aa]"
            />
            <span>Force single node instead (only if it fits)</span>
          </label>
        )}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Visibility</span>
          <div className="flex border border-border">
            {(["network", "private"] as ServeVisibility[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className={
                  "px-2 py-1 text-[11px] uppercase tracking-wider " +
                  (visibility === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent")
                }
              >
                {v === "network" ? "Public" : "Private"}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">
            {visibility === "network" ? "any peer can route here" : "direct / LAN only"}
          </span>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={() => onServe({ forceSingle, userForced: forceCluster, visibility })}
          className="tnz-eyebrow border border-border bg-primary px-3 py-1.5 text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Serving…" : willCluster ? `Serve across ${preview.stages.length} nodes` : "Serve on this machine"}
        </button>
      </div>
    </div>
  );
}

function ServeFlow() {
  const local = useLocalModels();
  const [picked, setPicked] = useState<string | null>(null);
  // Model id currently in the assisted cluster-setup panel (before serving).
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Set of model_ids this user has registered as a provider for during
  // this session. Drives the "Serving" badge.
  const [serving, setServing] = useState<Set<string>>(new Set());
  // Network-wide endpoints — used to show "N total live providers for
  // this model" so the user sees market context before serving.
  const { endpoints } = useEndpoints();
  // Live provider stats from tenzro_providerStats. Polled every 5s
  // while the Serve flow is mounted.
  const [stats, setStats] = useState<{
    total_requests?: number;
    successful?: number;
    avg_latency?: string;
    total_earnings_wei?: string;
    total_rewards_wei?: string;
    max_concurrent?: number;
    current_active?: number;
    utilization?: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await invoke<any>("rpc_call", {
          args: { method: "tenzro_providerStats", params: {} },
        });
        if (!cancelled) setStats(resp?.result ?? null);
      } catch { /* node may not be ready */ }
      if (!cancelled) setTimeout(poll, 5_000);
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  const earningsTnzo = stats?.total_earnings_wei
    ? Number(BigInt(stats.total_earnings_wei)) / 1e18
    : 0;
  const rewardsTnzo = stats?.total_rewards_wei
    ? Number(BigInt(stats.total_rewards_wei)) / 1e18
    : 0;

  async function serve(modelId: string, opts?: ServeOptions) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      // Ensure the node advertises the model_provider role before it
      // registers as a provider, so peers route inference here. The node
      // replaces its role set wholesale, so add to the live set rather
      // than clobbering any validator/storage roles already served.
      const cur = await invoke<NodeStatus | null>("node_status");
      await invoke<string>("request_role_change", {
        roles: withRole(cur?.roles, "model_provider"),
      });
      const serveParams: Record<string, unknown> = { model_id: modelId };
      if (opts?.forceSingle) serveParams.force_single = true;
      if (opts?.userForced) serveParams.user_forced = true;
      serveParams.visibility = opts?.visibility ?? "network";
      await invoke<any>("rpc_call", {
        args: { method: "tenzro_serveModel", params: serveParams },
      });
      await invoke<any>("rpc_call", {
        args: { method: "tenzro_registerProvider", params: { model_id: modelId } },
      });
      setServing((s) => new Set(s).add(modelId));
      const where = opts?.visibility === "private" ? "privately (direct/LAN only)" : "to the network";
      setSuccess(`Serving ${modelId} ${where}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setPicked(null);
      setPreviewing(null);
    }
  }

  async function stopServing(modelId: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setPicked(modelId);
    try {
      const resp = await invoke<any>("rpc_call", {
        args: { method: "tenzro_stopModel", params: { model_id: modelId } },
      });
      if (resp?.error) throw new Error(resp.error.message ?? "stop failed");
      setServing((s) => {
        const next = new Set(s);
        next.delete(modelId);
        return next;
      });
      setSuccess(`Stopped serving ${modelId}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setPicked(null);
    }
  }

  if (!local) {
    return (
      <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading your downloaded models…
      </div>
    );
  }
  const downloaded = local.filter((m) => m.downloaded);
  if (downloaded.length === 0) {
    return (
      <div className="border border-border bg-card p-6">
        <h3 className="text-sm font-semibold">No models downloaded yet</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          To serve a model you first need to download one. Go to{" "}
          <span className="font-medium text-foreground">Run AI locally</span>{" "}
          and download a model — anything in your local catalog can be
          served to the network.
        </p>
      </div>
    );
  }
  // Per-model network-provider counts (so the user sees market context).
  const providerCount = new Map<string, number>();
  for (const ep of endpoints ?? []) {
    providerCount.set(ep.model_id, (providerCount.get(ep.model_id) ?? 0) + 1);
  }

  return (
    <div className="space-y-3">
      {/* Earnings + activity stats from tenzro_providerStats. */}
      <div className="grid grid-cols-4 gap-3">
        <StatBox
          label="Earnings (lifetime)"
          value={`${earningsTnzo.toFixed(4)} TNZO`}
          hint={stats?.utilization === "Active" ? "Active" : "Idle"}
        />
        <StatBox
          label="Rewards (lifetime)"
          value={`${rewardsTnzo.toFixed(4)} TNZO`}
          hint="from epoch distributions"
        />
        <StatBox
          label="Requests served"
          value={String(stats?.total_requests ?? "—")}
          hint={`avg ${stats?.avg_latency ?? "—"} latency`}
        />
        <StatBox
          label="Serving"
          value={`${stats?.current_active ?? serving.size} / ${stats?.max_concurrent ?? "?"}`}
          hint="active models / max concurrent"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-emerald-600 dark:text-emerald-400">{success}</p>}
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Pick a downloaded model to serve to the network
      </p>
      <ul className="space-y-2">
        {downloaded.map((m) => {
          const live = providerCount.get(m.id) ?? 0;
          const isServing = serving.has(m.id);
          const isPreviewing = previewing === m.id;
          return (
            <li key={m.id} className="border border-border bg-card">
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {m.name}
                    {isServing && (
                      <span className="border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        Serving
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {m.family} · {m.parameters} ·{" "}
                    {m.context_length.toLocaleString()} ctx
                    {live > 0 && (
                      <>
                        {" · "}
                        <span className="text-foreground/70">
                          {live} live provider{live === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isServing && (
                    <button
                      type="button"
                      onClick={() => stopServing(m.id)}
                      disabled={busy && picked === m.id}
                      className="tnz-eyebrow border border-border px-3 py-1.5 hover:border-destructive hover:text-destructive disabled:opacity-50"
                    >
                      {busy && picked === m.id ? "Stopping…" : "Stop"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewing(isPreviewing ? null : m.id)}
                    disabled={busy}
                    className="tnz-eyebrow border border-border bg-secondary px-3 py-1.5 text-secondary-foreground hover:bg-accent disabled:opacity-50"
                  >
                    {isPreviewing ? "Cancel" : isServing ? "Re-advertise" : "Serve to network"}
                  </button>
                </div>
              </div>
              {isPreviewing && (
                <ClusterPreviewPanel
                  modelId={m.id}
                  busy={busy && picked === m.id}
                  onServe={(opts) => { setPicked(m.id); serve(m.id, opts); }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatBox({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="tnz-eyebrow">{label}</div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

/** What this machine can offer on the network. Mirrors `CapabilityReadout`
 *  in tenzro-studio-core::hardware — the GUI never re-derives this policy. */
interface CapabilityReadout {
  ram_gb: number;
  physical_cores: number;
  gpu: string;
  free_disk_gb: number;
  offerable_storage_gb: number;
  can_serve_ai: boolean;
  can_serve_compute: boolean;
  can_serve_storage: boolean;
}

/** Live storage-provider state (`tenzro_storageStatus`). */
interface StorageStatus {
  is_storage_provider: boolean;
  effective_rate_wei: string;
  object_count: number;
}

/** Live compute-provider state (`tenzro_computeStatus`). */
interface ComputeStatus {
  is_compute_provider: boolean;
  effective_rate_wei: string;
  active_rentals: number;
}

/** Provider onboarding for storage + compute. One node, one stake, many
 *  roles: opting in adds the role to the live set without a restart, and the
 *  node refuses any role its hardware can't back. Read the capability readout
 *  first, then flip on whichever resources this machine can offer. */
function ProvideFlow() {
  const { status: wallet } = useWallet();
  const [cap, setCap] = useState<CapabilityReadout | null>(null);
  const [roles, setRoles] = useState<string>("");
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [compute, setCompute] = useState<ComputeStatus | null>(null);
  const [busy, setBusy] = useState<"storage" | "compute" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<CapabilityReadout>("capability_readout")
      .then((c) => { if (!cancelled) setCap(c); })
      .catch(() => { /* probe is best-effort */ });
    const poll = async () => {
      try {
        const s = await invoke<NodeStatus | null>("node_status");
        if (!cancelled && s) setRoles(s.roles);
      } catch { /* node may be starting */ }
      // Provider status RPCs error with -32004 until the role is active; we
      // treat that as "not providing yet" rather than surfacing an error.
      try {
        const r = await rpc<StorageStatus>("tenzro_storageStatus");
        if (!cancelled) setStorage(r);
      } catch { if (!cancelled) setStorage(null); }
      try {
        const r = await rpc<ComputeStatus>("tenzro_computeStatus");
        if (!cancelled) setCompute(r);
      } catch { if (!cancelled) setCompute(null); }
      if (!cancelled) setTimeout(poll, 5_000);
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  if (!wallet?.exists) return null;

  const servesStorage = roles.includes("storage");
  const servesCompute = roles.includes("ai") || roles.includes("model_provider");

  async function enable(role: "storage" | "model_provider") {
    setBusy(role === "storage" ? "storage" : "compute");
    setError(null);
    try {
      const cur = await invoke<NodeStatus | null>("node_status");
      await invoke<string>("request_role_change", {
        roles: withRole(cur?.roles, role),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <p className="tnz-eyebrow mb-3">What your machine can offer</p>
        {cap ? (
          <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
            <StatBox label="Memory" value={`${cap.ram_gb} GB`} hint={`${cap.physical_cores} cores`} />
            <StatBox label="Accelerator" value={cap.gpu} hint={cap.can_serve_ai ? "can serve AI" : "below AI floor"} />
            <StatBox label="Free disk" value={`${cap.free_disk_gb} GB`} hint={`${cap.offerable_storage_gb} GB offerable`} />
            <StatBox
              label="Roles live"
              value={roles ? formatRoles(roles) : "—"}
              hint="one stake, many roles"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Reading hardware…</p>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ProvideResource
          eyebrow="STO"
          title="Host storage"
          body="Offer spare disk to the network. You're paid per byte stored per epoch; a proof-of-retrievability challenge runs each epoch, and a miss stops the meter."
          capable={cap?.can_serve_storage ?? false}
          capableHint={cap ? `${cap.offerable_storage_gb} GB offerable after a safety reserve` : ""}
          incapableHint="No spare disk beyond the safety reserve."
          active={servesStorage}
          busy={busy === "storage"}
          status={
            storage
              ? `${storage.object_count} object${storage.object_count === 1 ? "" : "s"} · ${formatRateGiB(storage.effective_rate_wei)}`
              : undefined
          }
          onEnable={() => enable("storage")}
        />
        <ProvideResource
          eyebrow="CMP"
          title="Rent out compute"
          body="Offer CPU/GPU capacity for fixed-term rentals. You're paid per epoch; an availability proof gates each settlement so renters only pay for time you're actually reachable."
          capable={cap?.can_serve_compute ?? false}
          capableHint={cap ? `${cap.gpu} · ${cap.physical_cores} cores` : ""}
          incapableHint="Below the compute floor."
          active={servesCompute}
          busy={busy === "compute"}
          status={
            compute
              ? `${compute.active_rentals} active rental${compute.active_rentals === 1 ? "" : "s"} · ${formatRateEpoch(compute.effective_rate_wei)}`
              : undefined
          }
          onEnable={() => enable("model_provider")}
        />
      </section>

      {error && <ErrorBox title="Couldn't update provider role.">{error}</ErrorBox>}

      <p className="text-xs text-muted-foreground/80">
        Both services draw on the same provider stake and share one coverage
        budget. Earnings settle into your wallet as epochs pass.
      </p>
    </div>
  );
}

/** One provider resource card (storage or compute): capability gate, opt-in
 *  toggle, and live status once active. */
function ProvideResource({
  eyebrow, title, body, capable, capableHint, incapableHint, active, busy, status, onEnable,
}: {
  eyebrow: string;
  title: string;
  body: string;
  capable: boolean;
  capableHint: string;
  incapableHint: string;
  active: boolean;
  busy: boolean;
  status?: string;
  onEnable: () => void;
}) {
  return (
    <div className="border border-border bg-card p-6">
      <div className="flex items-center justify-between">
        <p className="tnz-eyebrow">{eyebrow}</p>
        {active && (
          <span className="tnz-eyebrow text-[var(--brand)]">● Live</span>
        )}
      </div>
      <h3 className="mt-3 text-lg font-medium tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
      <p className="mt-3 text-[11px] text-muted-foreground/80">
        {capable ? capableHint : incapableHint}
      </p>
      {active ? (
        <div className="mt-4 font-mono text-xs tabular-nums text-muted-foreground">
          {status ?? "starting…"}
        </div>
      ) : (
        <button
          onClick={onEnable}
          disabled={!capable || busy}
          className="mt-4 border border-border bg-background px-4 py-2 text-sm transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Enabling…" : "Start providing"}
        </button>
      )}
    </div>
  );
}

/** Wei-per-byte-epoch → a readable TNZO/GiB/epoch figure. */
function formatRateGiB(rateWei: string): string {
  try {
    const perGiBEpoch = (BigInt(rateWei) * 1073741824n);
    const tnzo = Number(perGiBEpoch) / 1e18;
    return `${tnzo.toPrecision(2)} TNZO / GiB·epoch`;
  } catch {
    return "rate —";
  }
}

/** Wei-per-epoch → a readable TNZO/epoch figure. */
function formatRateEpoch(rateWei: string): string {
  try {
    const tnzo = Number(BigInt(rateWei)) / 1e18;
    return `${tnzo.toPrecision(2)} TNZO / epoch`;
  } catch {
    return "rate —";
  }
}

/** Minimal Validator flow: deposit TNZO and submit a validator join
 *  request via tenzro_stake. */
/** Validator onboarding wizard: pre-flight checks → per-risk acknowledgment
 *  → deposit. Each risk is a separate checkbox tied to one concrete fact
 *  (Ethereum Launchpad pattern); we don't dump a wall of legalese. */
function ValidatorFlow() {
  const { status: wallet, refresh } = useWallet();
  const [step, setStep] = useState<"preflight" | "risks" | "deposit" | "submitted">("preflight");
  const [amount, setAmount] = useState("1000");
  const [acks, setAcks] = useState({ deposit: false, uptime: false, slashing: false, exit: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Node status — we need it for the preflight check.
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<NodeStatus | null>("node_status");
        if (!cancelled) setNodeStatus(s);
      } catch { /* ignore */ }
      if (!cancelled) setTimeout(poll, 5_000);
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  if (!wallet?.exists) return null;
  const balanceTnzo = Number(wallet.balance_display || "0");
  const requested = parseFloat(amount) || 0;
  const insufficient = requested > balanceTnzo;
  const acksOk = Object.values(acks).every(Boolean);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const wei = BigInt(Math.floor(parseFloat(amount) * 1e18)).toString();
      const resp = await invoke<any>("rpc_call", {
        args: { method: "tenzro_stake", params: { amount_wei: wei } },
      });
      const err = resp?.error;
      if (err) throw new Error(err.message ?? "deposit failed");
      setTxHash(resp?.result?.tx_hash ?? resp?.result ?? "pending");
      // Stake settled — add the validator role to the live set so the node
      // begins consensus participation without a restart, keeping any
      // model_provider/storage roles it already serves under the one stake.
      await invoke<string>("request_role_change", {
        roles: withRole(nodeStatus?.roles, "validator"),
      });
      setStep("submitted");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="border border-border bg-card p-6">
        <h3 className="text-sm font-semibold">Become a validator</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Deposit TNZO and your node will help secure the network. You earn
          rewards from block production; deposits are refundable when you
          exit (subject to an unbonding window). Requires uptime — keep
          this app running.
        </p>
        <div className="mt-3 flex items-center gap-2 text-xs">
          <StepDot active={step === "preflight"} done={step !== "preflight"} label="Pre-flight" />
          <StepArrow />
          <StepDot active={step === "risks"} done={step === "deposit" || step === "submitted"} label="Risks" />
          <StepArrow />
          <StepDot active={step === "deposit"} done={step === "submitted"} label="Deposit" />
          <StepArrow />
          <StepDot active={step === "submitted"} done={false} label="Live" />
        </div>
      </div>

      {step === "preflight" && (
        <div className="space-y-3 border border-border bg-card p-6">
          <h4 className="text-sm font-semibold">Pre-flight checks</h4>
          <PreflightItem
            label="Network connectivity"
            ok={(nodeStatus?.peer_count ?? 0) >= 1}
            detail={`Peers: ${nodeStatus?.peer_count ?? "checking…"}`}
          />
          <PreflightItem
            label="Chain sync"
            ok={(nodeStatus?.block_height ?? 0) > 0}
            detail={`Height: ${(nodeStatus?.block_height ?? 0).toLocaleString()}`}
          />
          <PreflightItem
            label="Sufficient balance"
            ok={balanceTnzo >= 100}
            detail={`${wallet.balance_display} TNZO available · minimum 100 TNZO recommended`}
          />
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setStep("risks")}
              className="border border-border bg-primary px-4 py-2 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "risks" && (
        <div className="space-y-4 border border-border bg-card p-6">
          <h4 className="text-sm font-semibold">Acknowledge each risk</h4>
          <p className="text-xs text-muted-foreground">
            Tick each item separately. Each is one concrete fact you should understand.
          </p>
          <AckCheckbox
            checked={acks.deposit}
            onChange={(v) => setAcks((a) => ({ ...a, deposit: v }))}
            label="My deposit is locked while I'm an active validator."
            hint="You can request exit at any time, but funds remain locked through the unbonding window."
          />
          <AckCheckbox
            checked={acks.uptime}
            onChange={(v) => setAcks((a) => ({ ...a, uptime: v }))}
            label="Sustained downtime reduces my rewards."
            hint="Brief outages are fine. Long absences mean missed block-production duties and lower earnings."
          />
          <AckCheckbox
            checked={acks.slashing}
            onChange={(v) => setAcks((a) => ({ ...a, slashing: v }))}
            label="Equivocation (signing conflicting blocks) is slashable."
            hint="Running the same validator key on two machines, or attacking the network, can burn a portion of the deposit. Standard operation can't trigger this."
          />
          <AckCheckbox
            checked={acks.exit}
            onChange={(v) => setAcks((a) => ({ ...a, exit: v }))}
            label="Exiting takes time. There's an unbonding window."
            hint="Funds become withdrawable after the unbonding window completes; no rewards during this window."
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep("preflight")}
              className="border border-border bg-secondary px-3 py-2 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep("deposit")}
              disabled={!acksOk}
              className="border border-border bg-primary px-4 py-2 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "deposit" && (
        <div className="space-y-4 border border-border bg-card p-6">
          <h4 className="text-sm font-semibold">Deposit</h4>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Amount (TNZO)
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min="100"
                step="100"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
                className="w-40 border border-border bg-background px-2 py-1 text-sm font-mono focus:outline-none focus:border-foreground"
              />
              <span className="text-xs text-muted-foreground">
                Balance: <span className="font-mono">{wallet.balance_display}</span> TNZO
              </span>
            </div>
            {insufficient && (
              <p className="mt-1 text-xs text-destructive">Insufficient balance.</p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep("risks")}
              disabled={busy}
              className="border border-border bg-secondary px-3 py-2 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || insufficient || requested <= 0}
              className="border border-emerald-600/40 bg-emerald-600 px-4 py-2 text-xs font-medium uppercase tracking-wider text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? "Submitting…" : `Deposit ${amount} TNZO`}
            </button>
          </div>
        </div>
      )}

      {step === "submitted" && (
        <>
          <div className="space-y-3 border border-emerald-600/40 bg-emerald-600/10 p-6 text-emerald-900 dark:text-emerald-200">
            <h4 className="text-sm font-semibold">Deposit submitted</h4>
            <p className="text-sm">
              Your validator deposit was accepted. You'll be admitted as a
              validator at the next epoch boundary; from that point on
              you'll help secure the network and earn rewards.
            </p>
            {txHash && (
              <p className="break-all text-xs font-mono text-emerald-700 dark:text-emerald-300">
                Tx: {txHash}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Keep this app running — validators that go offline for sustained
              periods miss reward duties.
            </p>
          </div>
          <ValidatorMonitorPanel />
          <ValidatorExitPanel onExited={() => setStep("preflight")} />
        </>
      )}
    </div>
  );
}

/** Live validator health while serving. Polls node_status every 5s and
 *  surfaces the signals that determine reward eligibility: connectivity,
 *  peer count, role, chain height, and uptime. A low peer count or a
 *  non-connected state is flagged because sustained downtime forfeits
 *  reward duties. */
function ValidatorMonitorPanel() {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<NodeStatus | null>("node_status");
        if (!cancelled && s) setStatus(s);
      } catch { /* node may be mid-restart */ }
      if (!cancelled) setTimeout(poll, 5_000);
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  const isValidator = status?.roles?.toLowerCase().includes("validator") ?? false;
  const healthy = status?.connectivity === "connected" && (status?.peer_count ?? 0) > 0;

  return (
    <div className="border border-border bg-card p-6">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Validator health</h4>
        <span
          className={`tnz-eyebrow ${healthy ? "text-foreground" : "text-destructive"}`}
        >
          {!status ? "Connecting" : healthy ? "Online" : "Degraded"}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3">
        <StatBox
          label="Connectivity"
          value={status?.connectivity ?? "—"}
          hint={isValidator ? "validator" : formatRoles(status?.roles)}
        />
        <StatBox
          label="Peers"
          value={String(status?.peer_count ?? "—")}
          hint={(status?.peer_count ?? 0) > 0 ? "gossip reachable" : "no peers — at risk"}
        />
        <StatBox
          label="Block height"
          value={status?.block_height?.toLocaleString() ?? "—"}
          hint="local chain tip"
        />
        <StatBox
          label="Uptime"
          value={status ? formatUptime(status.uptime_secs) : "—"}
          hint="this session"
        />
      </div>
      {status && !healthy && (
        <p className="mt-3 text-xs text-destructive">
          Node isn't fully connected. Validators that stay offline miss
          reward duties — check your network connection.
        </p>
      )}
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

/** Exit / unbonding panel. Calls tenzro_unstake which queues the
 *  validator's deposit into the unbonding window; rewards stop, funds
 *  become withdrawable after the chain's configured delay. */
function ValidatorExitPanel({ onExited }: { onExited: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function exit() {
    let ok = false;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      ok = await confirm(
        "Exit validator? Your deposit enters the unbonding window. No rewards during this period; funds become withdrawable after the window completes.",
        { title: "Exit validator", kind: "warning" },
      );
    } catch {
      ok = window.confirm("Exit validator? Deposit goes into unbonding window.");
    }
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await invoke<any>("rpc_call", {
        args: { method: "tenzro_unstake", params: {} },
      });
      const err = resp?.error;
      if (err) throw new Error(err.message ?? "unstake failed");
      setSuccess("Exit queued. Funds will be withdrawable when the unbonding window completes.");
      setTimeout(onExited, 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-border bg-card p-6 space-y-3">
      <h4 className="text-sm font-semibold">Exit validator</h4>
      <p className="text-xs text-muted-foreground">
        Stop validating + queue your deposit for refund. After the
        unbonding window completes, the deposit is withdrawable to your
        wallet. You'll see this transition reflected in the wallet
        balance once finalised.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-emerald-600 dark:text-emerald-400">{success}</p>}
      <button
        type="button"
        onClick={exit}
        disabled={busy}
        className="border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300 hover:bg-amber-600/20 disabled:opacity-50"
      >
        {busy ? "Submitting exit…" : "Exit validator"}
      </button>
    </div>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          done
            ? "bg-emerald-500"
            : active
              ? "bg-primary"
              : "bg-muted-foreground/30"
        }`}
      />
      <span className={active || done ? "text-foreground" : "text-muted-foreground/70"}>
        {label}
      </span>
    </span>
  );
}
function StepArrow() {
  return <span className="text-muted-foreground/40">→</span>;
}

function PreflightItem({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span
        className={`mt-0.5 inline-block h-3 w-3 rounded-full ${
          ok ? "bg-emerald-500" : "bg-amber-500"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function AckCheckbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 text-sm">
        <div>{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
    </label>
  );
}

function ErrorBox({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-destructive/40 bg-destructive/5 p-6 text-sm">
      <p className="font-medium text-destructive">{title}</p>
      <p className="mt-2 text-muted-foreground">{children}</p>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { EmptyState, ModelRowSkeleton } from "@/components/Skeleton";

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
  role: string;
  block_height: number;
  peer_count: number;
  uptime_secs: number;
  tee_capable: boolean;
  iroh_enabled: boolean;
  connectivity: "connecting" | "syncing" | "connected";
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
interface ModelEndpoint {
  instance_id: string;
  model_id: string;
  provider?: string;
  api_url?: string;
}

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

type CardId = "use-network" | "run-local" | "serve" | "validate";

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
      "Lowest barrier — no GPU required, no local downloads.",
  },
  {
    id: "run-local",
    title: "Run AI locally",
    tagline: "Download a model, chat in private",
    body:
      "Download a GGUF model from the registry, run it on your machine " +
      "with Metal / CUDA / ROCm acceleration. Stays on your device.",
  },
  {
    id: "serve",
    title: "Serve AI to the network",
    tagline: "Earn TNZO by serving models you run",
    body:
      "Pick a model, advertise it to the network as a provider, " +
      "earn TNZO from inference traffic. Requires capable hardware.",
  },
  {
    id: "validate",
    title: "Run a validator",
    tagline: "Stake TNZO and produce blocks",
    body:
      "Advanced. Stake TNZO, participate in HotStuff-2 consensus, " +
      "earn validator rewards. Requires uptime + a stake bond.",
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
      <CardFlow
        cardId={picked}
        onBack={() => setPicked(null)}
        status={status}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-5xl flex-1 px-8 pt-16">
        <header className="mb-12">
          <h1 className="text-3xl font-semibold tracking-tight">
            Ipnops Edge
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Run, serve, and contribute AI to the Tenzro Network.
          </p>
        </header>

        <section>
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            What do you want to do?
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {CARDS.map((card) => (
              <button
                key={card.id}
                onClick={() => setPicked(card.id)}
                className="border border-border bg-card p-6 text-left transition hover:bg-accent"
              >
                <h3 className="text-base font-medium">{card.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {card.tagline}
                </p>
                <p className="mt-3 text-sm leading-relaxed">{card.body}</p>
              </button>
            ))}
          </div>
        </section>
      </main>

      <StatusBar status={status} />
    </div>
  );
}

function StatusBar({ status }: { status: NodeStatus | null }) {
  const [restarting, setRestarting] = useState(false);

  if (!status) {
    return (
      <footer className="border-t border-border bg-card px-6 py-3 text-xs text-muted-foreground">
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

  return (
    <footer className="flex items-center gap-6 border-t border-border bg-card px-6 py-3 text-xs text-muted-foreground">
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
      <span className="text-muted-foreground/70">{status.role}</span>
      <Sep />
      <span className="text-muted-foreground/70">
        Uptime {Math.floor(status.uptime_secs / 60)}m
      </span>
      {showRetry && (
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
    </footer>
  );
}

function Sep() {
  return <span className="text-muted-foreground/40">·</span>;
}

interface CardFlowProps {
  cardId: CardId;
  onBack: () => void;
  status: NodeStatus | null;
}

function CardFlow({ cardId, onBack, status }: CardFlowProps) {
  const card = CARDS.find((c) => c.id === cardId)!;
  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-5xl flex-1 px-8 pt-12">
        <button
          onClick={onBack}
          className="mb-8 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          ← Back
        </button>
        <h1 className="text-2xl font-semibold">{card.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{card.tagline}</p>

        <div className="mt-10">
          {cardId === "use-network" && <UseNetworkFlow />}
          {cardId === "run-local" && <RunLocalFlow />}
          {cardId === "serve" && <Placeholder>
            Pick a model you've downloaded, set pricing, register as a
            provider, start earning from inference traffic routed to
            your node.
          </Placeholder>}
          {cardId === "validate" && <Placeholder>
            Stake TNZO, generate validator keys (Ed25519 + ML-DSA-65 +
            BLS), submit a join request, participate in consensus once
            admitted at the next epoch.
          </Placeholder>}
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

    const attempt = async () => {
      if (cancelled) return;
      try {
        const list = await rpc<ModelInfo[]>("tenzro_listModels");
        if (cancelled) return;
        setModels(list);
        setWaiting(false);
        everLoaded = true;
        backoff = 2_000;
        // Settle into a slow refresh so newly-advertised models show up.
        timer = setTimeout(attempt, 10_000);
      } catch {
        if (cancelled) return;
        // Keep retrying forever — the node may still be connecting.
        // Surface a non-fatal "waiting" state only before the first
        // successful load so an established catalog doesn't flicker to
        // a waiting banner on a transient refresh failure.
        if (!everLoaded) setWaiting(true);
        backoff = Math.min(backoff * 1.5, 15_000);
        timer = setTimeout(attempt, backoff);
      }
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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

  const provider = providers[0]; // pick the first one for now; routing logic lives in the node later

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

  async function send() {
    if (!input.trim() || sending) return;
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
      // POST to the provider's api_url. The /v1/chat/completions
      // endpoint is the OpenAI-compatible path the node serves.
      const url = (provider.api_url ?? "").replace(/\/$/, "") + "/v1/chat/completions";
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
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <BackBtn onClick={onBack} />
      <ModelHeader model={model} extra={`via ${provider.provider ?? "remote"}`} />
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

  if (picked) {
    return <LocalModelPane model={picked} onBack={() => setPicked(null)} />;
  }

  // Prefer the full catalog when we have it; otherwise fall back to the
  // locally-present models so the user is never blocked on the network
  // for something already on their disk.
  const list = models ?? local;

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

  return (
    <div>
      {waiting && !models && (
        <div className="mb-4">
          <WaitingForNetwork compact />
        </div>
      )}
      <p className="mb-4 text-xs uppercase tracking-wider text-muted-foreground">
        {list.length} model{list.length === 1 ? "" : "s"}
        {downloadedCount > 0 ? ` · ${downloadedCount} downloaded` : ""}
      </p>
      <ul className="space-y-2">
        {list.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => setPicked(m)}
              className="w-full border border-border bg-card p-4 text-left transition hover:bg-accent"
            >
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    {m.downloaded && <DownloadedBadge />}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {m.family} · {m.parameters} ·{" "}
                    {m.context_length.toLocaleString()} ctx
                    {m.quantization ? ` · ${m.quantization}` : ""}
                  </div>
                </div>
                <SizeTag bytes={m.size_bytes} minRam={m.min_ram_gb} />
              </div>
              {m.description && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {m.description}
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DownloadedBadge() {
  return (
    <span className="border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
      Downloaded
    </span>
  );
}

function SizeTag({ bytes, minRam }: { bytes?: number; minRam?: number }) {
  if (!bytes) return null;
  const gb = bytes / 1024 / 1024 / 1024;
  return (
    <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
      {gb.toFixed(2)} GB
      {minRam ? ` · ${minRam} GB RAM` : ""}
    </span>
  );
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

  // On mount: if model is already downloaded, jump straight to ready —
  // the sidecar runs llama-server in router mode and auto-loads the
  // GGUF on the first /v1/chat/completions request. No explicit
  // serve/load step needed.
  useEffect(() => {
    if (!model.downloaded) return;
    setState({ kind: "ready" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
   *     pure overhead and was a documented amplifier of the whole-
   *     screen flicker we hit on M-series GPUs.
   *  2. 30 fps is the SOTA streaming chat refresh rate (LM Studio,
   *     Claude.ai web). The eye does not notice token-level latency
   *     above that threshold; the GPU very much does.
   */
  async function runStream(history: ChatMsg[]) {
    setSending(true);
    setChatError(null);

    const buf: string[] = [];
    let pending: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_INTERVAL_MS = 33;
    const flush = () => {
      pending = null;
      if (buf.length === 0) return;
      const chunk = buf.join("");
      buf.length = 0;
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, content: last.content + chunk };
        }
        return next;
      });
    };
    const scheduleFlush = () => {
      if (pending == null) {
        pending = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
    };

    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random()}`;
    inflightId.current = requestId;

    const onEvent = new Channel<ChatEvent>();
    let stats: AssistantStats = {};
    onEvent.onmessage = (evt) => {
      switch (evt.kind) {
        case "started":
          stats = { ...stats, ttft_ms: evt.ttft_ms };
          break;
        case "delta":
          buf.push(evt.content);
          scheduleFlush();
          break;
        case "usage":
          stats = {
            ...stats,
            prompt_tokens: evt.prompt_tokens,
            completion_tokens: evt.completion_tokens,
            tok_per_sec: evt.tok_per_sec,
          };
          break;
        case "done":
          stats = { ...stats, finish_reason: evt.finish_reason };
          break;
        case "error":
          setChatError(evt.message);
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
      // "cancelled" is a user-initiated stop, not an error worth
      // surfacing — the chat history keeps whatever streamed in.
      if (!msg.includes("cancelled")) {
        console.error(`[sidecar_chat_stream] ${model.id} failed:`, e);
        setChatError(msg);
      }
    } finally {
      if (pending != null) {
        clearTimeout(pending);
        pending = null;
      }
      flush();
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, stats, streaming: false };
        }
        return next;
      });
      inflightId.current = null;
      setSending(false);
    }
  }

  /** Append a user message + an assistant placeholder and stream the
   *  reply. The placeholder content reflects whether we're actually
   *  streaming or still waiting for the engine. */
  async function dispatch(text: string, waitingForEngine: boolean) {
    const userMsg: ChatMsg = { role: "user", content: text };
    const baseHistory = [...messages, userMsg];
    setMessages([...baseHistory, { role: "assistant", content: "", streaming: true }]);
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
        <ChatBox
          messages={messages}
          input={input}
          setInput={setInput}
          sending={sending || !!queued}
          error={chatError}
          onSend={sendChat}
          onCancel={cancelChat}
          onRegenerate={regenerateLast}
          placeholder={`Message ${model.name}…`}
          engineHint={
            queued
              ? "Waiting for the model to be ready — your message will send automatically…"
              : !engineReady
                ? engineLoading
                  ? "Loading model into memory…"
                  : "Starting inference engine…"
                : undefined
          }
        />
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
            // Only the trailing assistant message gets the
            // Regenerate affordance.
            onRegenerate={
              i === messages.length - 1 && m.role === "assistant" && !m.streaming
                ? onRegenerate
                : undefined
            }
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
}: {
  msg: ChatMsg;
  onRegenerate?: () => void;
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

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border bg-card p-6">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
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

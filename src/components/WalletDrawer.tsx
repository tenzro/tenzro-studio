import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import qrcodeGenerator from "qrcode-generator";
import {
  getCurrentHeader,
  getSyncStatus,
  formatAge,
  type CurrentHeader,
  type StalenessTier,
  type SyncStatus,
} from "../lib/chain";

export interface WalletStatus {
  exists: boolean;
  address: string;
  display_address: string;
  balance_wei: string;
  balance_display: string;
  node_ready: boolean;
}

interface TxRecord {
  hash?: string;
  from?: string;
  to?: string;
  value_wei?: string;
  block_number?: number;
  timestamp?: number;
  status?: string;
  // The node serialises records as-is — tolerant shape.
  [k: string]: unknown;
}

/** Slide-in wallet drawer: balance, address (QR + copy), recent
 *  transactions, top-up CTA. Replaces the previous flat modal.
 *
 *  All reads are in-process: balance from the embedded node's chain
 *  state, tx history from tenzro_getTransactionHistory. Sending is
 *  routed through tenzro_signAndSendTransaction via rpc_call. */
export function WalletDrawer({
  status,
  onClose,
  onRefresh,
}: {
  status: WalletStatus;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [txs, setTxs] = useState<TxRecord[] | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  // Header freshness + sync progress — both polled together so the
  // header/sync chips never disagree on what tip they refer to.
  // 10s cadence is generous; the chain produces blocks every few
  // seconds so missing a tick doesn't lose useful information.
  const [header, setHeader] = useState<CurrentHeader | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const [h, s] = await Promise.all([
          getCurrentHeader().catch(() => null),
          getSyncStatus(),
        ]);
        if (cancelled) return;
        if (h) setHeader(h);
        if (s) setSync(s);
      } catch {
        // Embedded node not ready — keep last values.
      }
    };
    tick();
    timer = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Load transaction history on open + refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await invoke<{ result?: TxRecord[] | { data?: TxRecord[] } }>(
          "rpc_call",
          {
            args: {
              method: "tenzro_getTransactionHistory",
              params: { address: status.address },
            },
          },
        );
        if (cancelled) return;
        const result = (resp as any)?.result ?? resp;
        const list = Array.isArray(result)
          ? result
          : Array.isArray((result as any)?.data)
            ? (result as any).data
            : [];
        // Filter to this wallet's address (defensive — node may return
        // unfiltered history if it doesn't index per-address yet).
        const addrLower = status.address.toLowerCase();
        const mine = list.filter((tx: TxRecord) => {
          const f = (tx.from as string | undefined)?.toLowerCase();
          const t = (tx.to as string | undefined)?.toLowerCase();
          return f === addrLower || t === addrLower;
        });
        setTxs(mine);
      } catch (e) {
        if (!cancelled) setTxError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [status.address]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(status.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  }

  async function reclaimFaucet() {
    try {
      const resp = await invoke<{ result?: unknown; error?: { message: string } }>(
        "rpc_call",
        { args: { method: "tenzro_faucet", params: { address: status.address } } },
      );
      const err = (resp as any)?.error;
      if (err) {
        // Faucet enforces 24h per-address cooldown; surface the message.
        const { message } = await import("@tauri-apps/plugin-dialog");
        await message(`Faucet: ${err.message}`, { title: "Top-up", kind: "info" });
      } else {
        onRefresh();
        const { message } = await import("@tauri-apps/plugin-dialog");
        await message("10,000 TNZO credited to your wallet.", {
          title: "Top-up successful",
          kind: "info",
        });
      }
    } catch (e) {
      console.warn("faucet failed:", e);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-border p-5">
          <div>
            <h2 className="text-base font-semibold">Wallet</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Local MPC wallet · keystore stays on this machine</span>
              <FreshnessChip header={header} />
              <SyncChip sync={sync} />
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">
          {/* Balance */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Balance
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold font-mono">
                {status.balance_display}
              </span>
              <span className="text-sm text-muted-foreground">TNZO</span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={reclaimFaucet}
                className="border border-emerald-600/40 bg-emerald-600/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/20"
                title="Testnet: 10,000 TNZO per 24h"
              >
                Top up (faucet)
              </button>
              <button
                onClick={() => setSendOpen((v) => !v)}
                disabled={
                  header?.tier === "stale_red" || header?.tier === "invalid"
                }
                title={
                  header?.tier === "stale_red"
                    ? "Chain state too old — wait for resync before sending"
                    : header?.tier === "invalid"
                      ? "Chain state out of sync — wait for resync before sending"
                      : "Send TNZO"
                }
                className="border border-border bg-secondary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-secondary"
              >
                Send
              </button>
              <button
                onClick={onRefresh}
                className="border border-border bg-secondary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Send pane */}
          {sendOpen && <SendPane fromAddress={status.address} onSent={onRefresh} />}

          {/* Address */}
          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Address
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="break-all text-xs font-mono text-foreground">
                {status.address}
              </code>
              <button
                onClick={copyAddress}
                className="shrink-0 border border-border bg-secondary px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Display address
              </div>
              <code className="break-all text-xs font-mono text-muted-foreground">
                {status.display_address}
              </code>
            </div>
            <div className="mt-3">
              <QRCode value={status.address} />
            </div>
          </div>

          {/* Transactions */}
          <div className="mt-6">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Recent transactions
            </div>
            {txError && (
              <p className="text-xs text-destructive">{txError}</p>
            )}
            {txs == null && !txError && (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
            {txs && txs.length === 0 && !txError && (
              <p className="text-xs text-muted-foreground">
                No transactions yet.
              </p>
            )}
            {txs && txs.length > 0 && (
              <ul className="space-y-1">
                {txs.slice(0, 20).map((tx, i) => (
                  <TxRow key={(tx.hash as string) ?? `tx-${i}`} tx={tx} myAddress={status.address} />
                ))}
              </ul>
            )}
          </div>

          <div className="mt-8 text-[10px] text-muted-foreground">
            Keystore at <code className="font-mono">~/.tenzro/inference/wallets/</code> ·
            Argon2id-encrypted · never transmitted
          </div>
        </div>
      </div>
    </div>
  );
}

function SendPane({
  fromAddress,
  onSent,
}: {
  fromAddress: string;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const wei = BigInt(Math.floor(parseFloat(amount) * 1e18)).toString();
      const resp = await invoke<any>("rpc_call", {
        args: {
          method: "tenzro_signAndSendTransaction",
          params: { from: fromAddress, to, value: wei },
        },
      });
      const err = resp?.error;
      if (err) throw new Error(err.message ?? "send failed");
      setSuccess(`Sent. Tx hash: ${resp?.result ?? "(pending)"}`);
      setTo("");
      setAmount("");
      onSent();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 border border-border bg-card/60 p-3">
      <div>
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          To address
        </label>
        <input
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x…"
          disabled={busy}
          className="mt-1 w-full border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:border-foreground"
        />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Amount (TNZO)
        </label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min="0"
          step="0.0001"
          disabled={busy}
          className="mt-1 w-32 border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:border-foreground"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {success && <p className="break-all text-xs text-emerald-600 dark:text-emerald-400">{success}</p>}
      <button
        type="button"
        onClick={send}
        disabled={busy || !to.trim() || !amount.trim()}
        className="border border-border bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send TNZO"}
      </button>
    </div>
  );
}

function TxRow({ tx, myAddress }: { tx: TxRecord; myAddress: string }) {
  const me = myAddress.toLowerCase();
  const from = (tx.from as string | undefined)?.toLowerCase() ?? "";
  const to = (tx.to as string | undefined)?.toLowerCase() ?? "";
  const direction = from === me ? "out" : to === me ? "in" : "—";
  const counterparty = direction === "out" ? tx.to : tx.from;
  const valueWei = BigInt((tx.value_wei as string) ?? "0");
  const valueTnzo = Number(valueWei) / 1e18;
  const ts = (tx.timestamp as number | undefined) ?? 0;
  return (
    <li className="flex items-center justify-between gap-3 border border-border bg-card/40 px-3 py-2 text-xs">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`font-semibold uppercase ${
              direction === "in"
                ? "text-emerald-600 dark:text-emerald-400"
                : direction === "out"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground"
            }`}
          >
            {direction}
          </span>
          <span className="truncate font-mono text-muted-foreground" title={String(counterparty)}>
            {shortAddress(counterparty as string | undefined)}
          </span>
        </div>
        {ts > 0 && (
          <div className="text-[10px] text-muted-foreground/70">
            {new Date(ts * 1000).toLocaleString()}
          </div>
        )}
      </div>
      <div className="text-right font-mono">
        <span className={direction === "in" ? "text-emerald-600 dark:text-emerald-400" : ""}>
          {direction === "in" ? "+" : direction === "out" ? "-" : ""}
          {valueTnzo.toFixed(4)}
        </span>{" "}
        <span className="text-muted-foreground">TNZO</span>
      </div>
    </li>
  );
}

/** Chain-freshness chip — drives the staleness gate on signing
 *  decisions. Color + label per tier; the same threshold table the
 *  node's `classify_header_age` enforces. When
 *  the embedded node hasn't booted yet, we render a soft "checking"
 *  state instead of nothing so the user sees the surface is alive. */
function FreshnessChip({ header }: { header: CurrentHeader | null }) {
  if (!header) {
    return (
      <span className="rounded border border-border bg-secondary/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
        Checking…
      </span>
    );
  }
  const { tier, age_secs } = header;
  const styles: Record<StalenessTier, string> = {
    live: "border-emerald-600/40 bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
    stale_yellow: "border-amber-600/40 bg-amber-600/10 text-amber-600 dark:text-amber-400",
    stale_red: "border-destructive/40 bg-destructive/10 text-destructive",
    invalid: "border-destructive/60 bg-destructive/20 text-destructive",
    unknown: "border-border bg-secondary text-muted-foreground",
  };
  const label: Record<StalenessTier, string> = {
    live: `live · ${formatAge(age_secs)}`,
    stale_yellow: `stale · ${formatAge(age_secs)}`,
    stale_red: `very stale · ${formatAge(age_secs)}`,
    invalid: `out of sync · ${formatAge(age_secs)}`,
    unknown: "unknown",
  };
  const title: Record<StalenessTier, string> = {
    live: "Chain state is current — signing trusted.",
    stale_yellow: "Chain state is a bit behind — signing allowed with caution.",
    stale_red: "Chain state too old — value transfers disabled until resync.",
    invalid: "Chain state out of sync — force a resync before signing.",
    unknown: "Chain head not available yet — node may still be starting.",
  };
  return (
    <span
      title={title[tier]}
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${styles[tier]}`}
    >
      {label[tier]}
    </span>
  );
}

/** Sync-progress chip — shows local tip vs network tip. Green when
 *  caught up, amber while catching up. Hidden when sync status isn't
 *  available (single-node testnet, network silence, or node still
 *  booting). The node's `tenzro_syncing` already applies a 2-block
 *  jitter threshold so we don't flicker mid-block. */
function SyncChip({ sync }: { sync: SyncStatus | null }) {
  if (!sync) return null;
  if (!sync.is_syncing) {
    return (
      <span
        title={`In sync · block ${sync.local_tip.toLocaleString()}`}
        className="rounded border border-emerald-600/40 bg-emerald-600/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400"
      >
        in sync
      </span>
    );
  }
  const behind = Math.max(0, sync.network_tip - sync.local_tip);
  return (
    <span
      title={`Catching up — ${sync.local_tip.toLocaleString()} / ${sync.network_tip.toLocaleString()} (${behind} blocks behind)`}
      className="rounded border border-amber-600/40 bg-amber-600/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400"
    >
      syncing · {behind} behind
    </span>
  );
}

function shortAddress(addr: string | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Real QR for the wallet address, rendered as a crisp SVG. Uses the
 *  bundled `qrcode-generator` encoder (pure JS, no network) so it works
 *  offline. Modules paint in `currentColor` so the QR inherits the
 *  foreground colour and reads in both themes. */
function QRCode({ value }: { value: string }) {
  const path = useMemo(() => {
    if (!value) return null;
    try {
      const qr = qrcodeGenerator(0, "M");
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      let d = "";
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) {
            d += `M${col} ${row}h1v1h-1z`;
          }
        }
      }
      return { d, count };
    } catch {
      return null;
    }
  }, [value]);

  return (
    <div className="flex flex-col items-center gap-3 border border-border bg-card p-4">
      {path ? (
        <svg
          viewBox={`-2 -2 ${path.count + 4} ${path.count + 4}`}
          className="h-40 w-40 text-foreground"
          role="img"
          aria-label="Wallet address QR code"
          shapeRendering="crispEdges"
        >
          <rect
            x={-2}
            y={-2}
            width={path.count + 4}
            height={path.count + 4}
            className="fill-background"
          />
          <path d={path.d} fill="currentColor" />
        </svg>
      ) : (
        <div className="flex h-40 w-40 items-center justify-center text-xs text-muted-foreground">
          No address yet
        </div>
      )}
      <code className="break-all text-center text-[10px] font-mono text-muted-foreground">
        {value}
      </code>
    </div>
  );
}

//! Tenzro wallet integration — local keystore reads + in-process balance
//! queries.
//!
//! Architecture: the wallet is the **user's local secret** (an MPC-share
//! keystore on disk at `<data_dir>/wallets/`). The balance is a read of
//! the chain state the embedded node already syncs locally. So both
//! operations happen entirely on-device — no JSON-RPC roundtrip, no
//! network call. The Tauri commands here reach into the in-process
//! `NodeHandle` directly:
//!
//! - [`wallet_status`] — calls `wallet_service.list_wallets()` to
//!   discover the user's existing wallets. Returns the first wallet's
//!   address + its current TNZO balance (read via `node.token().balance_of(addr)`,
//!   the same path `tenzro_getBalance` uses internally). If no wallet
//!   exists yet, returns `{exists: false}` so the UI can render a
//!   one-click "Create wallet" affordance.
//!
//! - [`wallet_create`] — calls `wallet_service.provision_wallet()`,
//!   the canonical wallet-creation entrypoint. Writes a fresh MPC
//!   keypair into the local keystore + returns its address.
//!
//! Wallet keystore lives at `<data_dir>/wallets/` (where
//! tenzro-node's NodeConfig already points it). Argon2id-encrypted
//! key shares; sensitive material zeroized on drop (per the wallet
//! crate's docs).

use serde::Serialize;
use tauri::State;

use crate::AppState;

/// What the UI status-bar wallet chip needs in one round-trip.
#[derive(Debug, Serialize)]
pub struct WalletStatusView {
    /// True iff the user already has at least one wallet provisioned.
    /// When false, the rest of the fields are placeholder zeroes and
    /// the UI should show a "Create wallet" affordance.
    pub exists: bool,
    /// Canonical hex address of the primary wallet (the first one in
    /// the keystore, deterministic ordering). Empty when `exists == false`.
    pub address: String,
    /// Human-readable display address (e.g. base58-encoded). Empty when
    /// `exists == false`.
    pub display_address: String,
    /// TNZO balance in base units (u128 fits the full TNZO supply, but
    /// it's serialised as a decimal string so JS BigInt isn't required).
    pub balance_wei: String,
    /// Same balance formatted as a human-readable TNZO float (e.g.
    /// "123.456"). Empty when `exists == false`. Convenience field so
    /// the UI doesn't need TNZO-decimals arithmetic in JS.
    pub balance_display: String,
    /// True if the embedded node is up (and so the balance is current);
    /// false if the node hasn't started yet (balance shown is the last
    /// known value from storage, or zero).
    pub node_ready: bool,
}

const TNZO_DECIMALS: u32 = 18;

fn format_tnzo(balance_wei: u128) -> String {
    // 1 TNZO = 10^18 base units. Show 4 decimal places.
    let whole = balance_wei / 10u128.pow(TNZO_DECIMALS);
    let frac = balance_wei % 10u128.pow(TNZO_DECIMALS);
    let frac_4 = frac / 10u128.pow(TNZO_DECIMALS - 4);
    format!("{}.{:04}", whole, frac_4)
}

/// Read the current wallet state. Called by the status-bar chip on a
/// short poll so balance updates appear without a manual refresh.
#[tauri::command]
pub async fn wallet_status(state: State<'_, AppState>) -> Result<WalletStatusView, String> {
    let node_arc = {
        let guard = state.node.read().await;
        guard.as_ref().map(|h| h.node())
    };
    let Some(node) = node_arc else {
        return Ok(WalletStatusView {
            exists: false,
            address: String::new(),
            display_address: String::new(),
            balance_wei: "0".into(),
            balance_display: "—".into(),
            node_ready: false,
        });
    };

    let Some(wallet_service) = node.wallet_service() else {
        return Ok(WalletStatusView {
            exists: false,
            address: String::new(),
            display_address: String::new(),
            balance_wei: "0".into(),
            balance_display: "—".into(),
            node_ready: true,
        });
    };

    // The node is up, so node_ready is true from here on regardless of what
    // the keystore reports. A wallet that's listed-but-unreadable — e.g. a
    // FROST share persisted under a password on a prior provisioned run, now
    // opened by an ephemeral (passwordless) keystore that can't decrypt it —
    // must NOT throw: that would make the chip poll error forever and read as
    // "node starting". Degrade to "no usable wallet" so the UI offers Create.
    let not_ready_but_no_wallet = || WalletStatusView {
        exists: false,
        address: String::new(),
        display_address: String::new(),
        balance_wei: "0".into(),
        balance_display: "—".into(),
        node_ready: true,
    };

    use tenzro_wallet::traits::WalletService;
    let ws: &tenzro_wallet::service::TenzroWalletService = wallet_service.as_ref();
    let ids = match WalletService::list_wallets(ws).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!("wallet_status: list_wallets failed ({e}); reporting no wallet");
            return Ok(not_ready_but_no_wallet());
        }
    };

    let Some(first_id) = ids.into_iter().next() else {
        return Ok(not_ready_but_no_wallet());
    };

    let wallet = match WalletService::get_wallet(ws, &first_id).await {
        Ok(Some(w)) => w,
        Ok(None) => return Ok(not_ready_but_no_wallet()),
        Err(e) => {
            tracing::warn!("wallet_status: get_wallet failed ({e}); likely an undecryptable share under an ephemeral keystore — reporting no wallet");
            return Ok(not_ready_but_no_wallet());
        }
    };

    let hex_address = format!("0x{}", hex::encode(wallet.public_key.as_bytes()));

    // Balance: read TnzoToken in-process. Same source the
    // tenzro_getBalance RPC uses (cache + RocksDB-backed), but no
    // JSON-RPC roundtrip.
    let balance_wei = node
        .token()
        .map(|t| t.balance_of(&wallet.address))
        .unwrap_or(0);

    Ok(WalletStatusView {
        exists: true,
        address: hex_address,
        display_address: format!("{}", wallet.address),
        balance_wei: balance_wei.to_string(),
        balance_display: format_tnzo(balance_wei),
        node_ready: true,
    })
}

/// Provision a brand-new MPC wallet via the in-process wallet service.
/// Returns the new wallet's address so the UI can immediately surface
/// it. Idempotency: each call creates a NEW wallet — the UI should
/// only call this when `wallet_status().exists == false`.
#[tauri::command]
pub async fn wallet_create(state: State<'_, AppState>) -> Result<WalletStatusView, String> {
    let node_arc = {
        let guard = state.node.read().await;
        guard
            .as_ref()
            .map(|h| h.node())
            .ok_or_else(|| "embedded node not running yet — wait for it to start".to_string())?
    };

    let wallet_service = node_arc
        .wallet_service()
        .ok_or_else(|| "wallet service not initialised".to_string())?;

    use tenzro_wallet::traits::WalletService;
    let ws: &tenzro_wallet::service::TenzroWalletService = wallet_service.as_ref();
    let wallet = WalletService::provision_wallet(ws)
        .await
        .map_err(|e| format!("provision_wallet failed: {}", e))?;

    let hex_address = format!("0x{}", hex::encode(wallet.public_key.as_bytes()));

    tracing::info!(
        wallet_id = %wallet.wallet_id.0,
        address = %hex_address,
        "provisioned new MPC wallet"
    );

    // Testnet onboarding: auto-claim the starter faucet allotment so
    // the new wallet has enough TNZO to actually use the network (pay
    // model providers, deposit for validation) without the user having
    // to find a faucet manually. The faucet enforces a 24h per-address
    // cooldown server-side so this is safe to invoke unconditionally
    // on wallet creation. Failure is non-fatal — the wallet is still
    // created, the balance is just 0 until the user retries.
    if let Err(e) = crate::wallet::claim_faucet_via_node(&node_arc, &hex_address).await {
        tracing::warn!(
            address = %hex_address,
            error = %e,
            "faucet auto-claim on wallet creation failed (non-fatal); user can retry"
        );
    }

    let balance_wei = node_arc
        .token()
        .map(|t| t.balance_of(&wallet.address))
        .unwrap_or(0);

    Ok(WalletStatusView {
        exists: true,
        address: hex_address,
        display_address: format!("{}", wallet.address),
        balance_wei: balance_wei.to_string(),
        balance_display: format_tnzo(balance_wei),
        node_ready: true,
    })
}

/// Invoke the embedded node's faucet handler in-process via
/// [`tenzro_node::dispatch_embedded`] — same code path the JSON-RPC
/// endpoint uses, just without a network roundtrip. On testnet this
/// grants 10,000 TNZO per address with a 24h cooldown enforced
/// server-side.
async fn claim_faucet_via_node(
    node: &std::sync::Arc<tenzro_node::TenzroNode>,
    address_hex: &str,
) -> Result<(), String> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "tenzro_faucet",
        "params": { "address": address_hex },
        "id": 1,
    });
    let response = tenzro_node::dispatch_embedded(
        node,
        request,
        tenzro_node::EmbeddedAuth::default(),
    )
    .await;
    if let Some(err) = response.get("error") {
        return Err(format!("faucet error: {}", err));
    }
    Ok(())
}

import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

// UI heartbeat — pings the Rust watchdog every 2s so it can detect a
// WKWebView WebContent crash / jetsam / JS-thread freeze. Tauri 2.11
// does NOT expose wry's `with_on_web_content_process_terminate_handler`,
// so this RAF-driven ping is the only reliable signal. requestAnimationFrame
// is deliberate (not setInterval): RAF stops firing when the renderer is
// blocked or paused, which is exactly what we want — a real freeze stops
// the pings, the Rust watchdog notices, and triggers graceful shutdown
// so the llama-server sidecar doesn't orphan. See src-tauri/src/watchdog.rs.
const HEARTBEAT_INTERVAL_MS = 2000;
let lastPing = 0;
function heartbeatTick(ts: number) {
  if (ts - lastPing >= HEARTBEAT_INTERVAL_MS) {
    lastPing = ts;
    // Renderer dying mid-call is the expected failure mode here — just
    // swallow; the Rust side will detect the missing heartbeats anyway.
    invoke("ui_alive").catch(() => {});
  }
  requestAnimationFrame(heartbeatTick);
}
requestAnimationFrame(heartbeatTick);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

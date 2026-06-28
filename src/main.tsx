import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

// UI heartbeat — pings the Rust watchdog so it can detect a WKWebView
// WebContent crash / jetsam. Tauri 2.11 does NOT expose wry's
// `with_on_web_content_process_terminate_handler`, so a JS-side ping is the
// only reliable signal. See src-tauri/src/watchdog.rs.
//
// IMPORTANT: this uses setInterval, NOT requestAnimationFrame. macOS WKWebView
// suspends RAF whenever the window is occluded or backgrounded — which is a
// LIVE, healthy renderer, not a crash. A RAF-based heartbeat therefore stops
// the moment the user clicks away or another window covers ours, and the
// watchdog kills a perfectly good app after 15s. setInterval keeps firing when
// backgrounded, so a missing ping genuinely means the renderer died. We also
// tell the watchdog when the document is hidden so it stands down entirely
// during backgrounding (belt and suspenders against throttled timers).
const HEARTBEAT_INTERVAL_MS = 2000;
function ping() {
  // Renderer dying mid-call is the expected failure mode — swallow; the Rust
  // side detects the missing heartbeats anyway.
  invoke("ui_alive").catch(() => {});
}
ping();
setInterval(ping, HEARTBEAT_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  invoke("ui_visibility", { hidden: document.hidden }).catch(() => {});
  if (!document.hidden) ping();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

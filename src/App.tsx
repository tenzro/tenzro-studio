import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import Home from "./pages/Home";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { get as getSetting, type ThemePref } from "./lib/settings";

export default function App() {
  // Theme: persisted preference (system/light/dark) from settings store.
  // Falls back to system on first launch.
  const [theme, setTheme] = useState<ThemePref>("system");
  const [isDark, setIsDark] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Apply theme — either pinned light/dark, or follow system.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await getSetting("theme");
        if (!cancelled) setTheme(t);
      } catch {
        // store may not have loaded yet; system fallback is fine.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const compute = (): boolean => {
      if (theme === "dark") return true;
      if (theme === "light") return false;
      return mql.matches;
    };
    const apply = () => {
      const dark = compute();
      document.documentElement.classList.toggle("dark", dark);
      setIsDark(dark);
    };
    apply();
    if (theme === "system") {
      const onChange = () => apply();
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
  }, [theme]);

  // Cmd-,/Ctrl-, opens Settings — the platform convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Native menu events from the macOS app menu (built in Rust setup()).
  // The Rust side emits a string id (e.g. "settings", "new_chat",
  // "palette", "wallet"); we dispatch here. Pages that need to react
  // (e.g. Home for "new_chat") listen for the same event independently.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u = await listen<string>("menu-event", (ev) => {
          switch (ev.payload) {
            case "settings":
              setSettingsOpen(true);
              break;
            case "palette":
              // The cmdk palette listens to its own Cmd-K keydown;
              // synth one so the menu click opens it too.
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
              );
              break;
            // "new_chat" / "wallet" handled in their respective panes.
            default: break;
          }
        });
        unlisten = u;
      } catch (e) {
        console.warn("menu-event listener failed:", e);
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  // Deep-link handler — tenzro-studio://… URLs. Today we only route
  // join-validator referral links to a toast + open the validator
  // card; extend as new schemes land.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const dl = await import("@tauri-apps/plugin-deep-link");
        // Cold-start: app launched via deep link.
        const cold = await dl.getCurrent();
        if (cold && cold.length > 0) handleDeepLink(cold[0]);
        // Live: arriving while app is running (single-instance routes here).
        const u = await dl.onOpenUrl((urls) => {
          if (urls.length > 0) handleDeepLink(urls[0]);
        });
        unlisten = u;
      } catch (e) {
        console.warn("deep-link wiring failed:", e);
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  function handleDeepLink(url: string) {
    try {
      const u = new URL(url);
      // tenzro-studio://join-validator?endpoint=…
      if (u.host === "join-validator") {
        toast(
          `Validator invite — go to Validate to review the deposit (endpoint: ${u.searchParams.get("endpoint") ?? "default"})`,
          { duration: 8000 },
        );
      } else {
        toast(`Opened: ${url}`);
      }
    } catch (e) {
      console.warn("bad deep link:", url, e);
    }
  }

  const commands: PaletteCommand[] = [
    {
      id: "open-settings",
      label: "Open settings",
      hint: "Theme, chat defaults, inference, privacy",
      shortcut: "⌘,",
      action: () => setSettingsOpen(true),
    },
    {
      id: "toggle-theme",
      label: isDark ? "Switch to light theme" : "Switch to dark theme",
      hint: "Override the persisted preference",
      shortcut: "⌘⇧L",
      action: () => {
        const next: ThemePref = isDark ? "light" : "dark";
        setTheme(next);
        import("./lib/settings").then((s) => s.set("theme", next));
        toast.success(next === "dark" ? "Dark theme" : "Light theme");
      },
    },
    {
      id: "show-shortcuts",
      label: "Show keyboard shortcuts",
      hint: "Cmd-K palette · Cmd-, settings · Cmd-Enter to send · Esc to stop",
      shortcut: "⌘/",
      action: () => {
        toast(
          "⌘K palette · ⌘, settings · ⌘↩ to send · Esc to stop",
          { duration: 6000 },
        );
      },
    },
  ];

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-foreground">
      <div className="title-drag-region" data-tauri-drag-region />
      <Home />
      <Toaster
        position="bottom-right"
        theme={isDark ? "dark" : "light"}
        toastOptions={{
          style: {
            border: "1px solid var(--border)",
            borderRadius: "0",
            background: "var(--popover)",
            color: "var(--popover-foreground)",
          },
        }}
        offset={48}
      />
      <CommandPalette commands={commands} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

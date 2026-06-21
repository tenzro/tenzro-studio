import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import Home from "./pages/Home";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";

export default function App() {
  // System-following theme.
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle("dark", dark);
      setIsDark(dark);
    };
    apply(mql.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Default command set — pages can extend this later via context if
  // we need scoped commands. v1: theme toggle + basic navigation
  // hints. New chat / model switching add when the conversation
  // sidebar lands (U6).
  const commands: PaletteCommand[] = [
    {
      id: "toggle-theme",
      label: isDark ? "Switch to light theme" : "Switch to dark theme",
      hint: "Override the system colour scheme",
      shortcut: "⌘⇧L",
      action: () => {
        const nowDark = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", nowDark);
        setIsDark(nowDark);
        toast.success(nowDark ? "Dark theme" : "Light theme");
      },
    },
    {
      id: "show-shortcuts",
      label: "Show keyboard shortcuts",
      hint: "Cmd-K palette · Cmd-Enter to send · Esc to stop · Cmd-, settings",
      shortcut: "⌘/",
      action: () => {
        toast(
          "⌘K palette · ⌘↩ to send · Esc to stop · ⌘, settings (when wired)",
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
    </div>
  );
}

import { Command } from "cmdk";
import { useEffect, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
}

/** Cmd-K / Ctrl-K command palette — the Linear / Raycast pattern.
 *  Bound globally; consumers pass their action list. */
export function CommandPalette({ commands }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-32 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" shouldFilter>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command…"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground/60"
            autoFocus
          />
          <Command.List className="max-h-80 overflow-y-auto p-1">
            <Command.Empty className="px-4 py-6 text-center text-xs text-muted-foreground">
              No commands match.
            </Command.Empty>
            {commands.map((c) => (
              <Command.Item
                key={c.id}
                value={`${c.label} ${c.hint ?? ""}`}
                onSelect={async () => {
                  setOpen(false);
                  setQuery("");
                  await c.action();
                }}
                className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm aria-selected:bg-accent"
              >
                <div className="flex flex-col">
                  <span>{c.label}</span>
                  {c.hint && (
                    <span className="text-xs text-muted-foreground">{c.hint}</span>
                  )}
                </div>
                {c.shortcut && (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {c.shortcut}
                  </span>
                )}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

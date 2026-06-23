import { useEffect, useState } from "react";
import {
  listConversations,
  deleteConversation,
  searchConversations,
  listProjects,
  createProject,
  assignConversationToProject,
  type ConversationRow,
  type ProjectRow,
} from "../lib/conversations";

interface Props {
  modelId: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Bumps when the parent appends a message — sidebar re-fetches. */
  refreshKey: number;
}

/** Left-rail sidebar showing the user's past chats with this model.
 *  Click → load that conversation's messages into the chat pane.
 *  Hover → reveal delete button. New chat button at top. */
export function ConversationSidebar({
  modelId,
  activeId,
  onSelect,
  onNew,
  refreshKey,
}: Props) {
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  // Filter chats by project. "all" = show all; "unfiled" = NULL;
  // otherwise a project id.
  const [projectFilter, setProjectFilter] = useState<"all" | "unfiled" | string>("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = query.trim();
        const [convs, projs] = await Promise.all([
          q ? searchConversations(q) : listConversations(),
          listProjects(),
        ]);
        if (cancelled) return;
        setProjects(projs);
        let filtered = convs.filter((r) => r.model_id === modelId);
        if (projectFilter === "unfiled") {
          filtered = filtered.filter((r) => !r.project_id);
        } else if (projectFilter !== "all") {
          filtered = filtered.filter((r) => r.project_id === projectFilter);
        }
        setRows(filtered);
      } catch (e) {
        console.warn("conversation list failed:", e);
        if (!cancelled) setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [modelId, refreshKey, query, projectFilter]);

  async function makeProject() {
    let name: string | null = null;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const ok = await ask("Create a new project? You'll be prompted for a name next.", {
        title: "New project",
        kind: "info",
      });
      if (!ok) return;
    } catch { /* fall through to prompt */ }
    name = window.prompt("Project name:");
    if (!name?.trim()) return;
    try {
      const id = await createProject({ name: name.trim() });
      setProjects((p) => [...p, {
        id, name: name!.trim(), description: null, color: null,
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      }]);
      setProjectFilter(id);
    } catch (e) {
      console.warn("createProject failed:", e);
    }
  }

  async function moveToProject(conversationId: string, projectId: string | null) {
    try {
      await assignConversationToProject(conversationId, projectId);
      // Refresh by re-applying the current filter.
      setRows((prev) => prev?.map((r) =>
        r.id === conversationId ? { ...r, project_id: projectId } : r,
      ) ?? null);
    } catch (e) {
      console.warn("assignConversationToProject failed:", e);
    }
  }

  async function remove(id: string) {
    let ok = false;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      ok = await confirm("Delete this conversation? This can't be undone.", {
        title: "Delete chat",
        kind: "warning",
      });
    } catch {
      ok = window.confirm("Delete this conversation? This can't be undone.");
    }
    if (!ok) return;
    try {
      await deleteConversation(id);
      setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
      if (activeId === id) onNew();
    } catch (e) {
      console.warn("deleteConversation failed:", e);
    }
  }

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-card/40">
      <div className="space-y-2 border-b border-border p-2">
        <button
          type="button"
          onClick={onNew}
          className="w-full border border-border bg-secondary px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-secondary-foreground hover:bg-accent"
        >
          + New chat
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="w-full border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:border-foreground"
        />
        <div className="flex items-center gap-1">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value as any)}
            className="flex-1 border border-border bg-background px-1.5 py-1 text-xs focus:outline-none focus:border-foreground"
          >
            <option value="all">All chats</option>
            <option value="unfiled">Unfiled</option>
            {projects.length > 0 && <option disabled>──────</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={makeProject}
            title="New project"
            className="border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent"
          >
            +
          </button>
        </div>
      </div>
      <ul className="overflow-y-auto p-2" style={{ maxHeight: "calc(100vh - 200px)" }}>
        {rows == null && (
          <li className="px-2 py-1 text-xs text-muted-foreground">Loading…</li>
        )}
        {rows && rows.length === 0 && (
          <li className="px-2 py-1 text-xs text-muted-foreground">
            No past chats yet.
          </li>
        )}
        {rows && rows.map((r) => (
          <li
            key={r.id}
            onMouseEnter={() => setHoverId(r.id)}
            onMouseLeave={() => setHoverId(null)}
            className={`group relative my-0.5 cursor-pointer px-2 py-1.5 text-xs ${
              activeId === r.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
            onClick={() => onSelect(r.id)}
          >
            <div className="truncate pr-6">{r.title}</div>
            <div className="text-[10px] text-muted-foreground/70">
              {relativeTime(r.updated_at)}
            </div>
            {hoverId === r.id && (
              <div className="absolute right-1 top-1 flex items-center gap-0.5">
                {projects.length > 0 && (
                  <select
                    value={r.project_id ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value;
                      moveToProject(r.id, v === "" ? null : v);
                    }}
                    title="Move to project"
                    className="border border-border bg-card px-1 py-0.5 text-[10px] text-muted-foreground focus:outline-none"
                  >
                    <option value="">Unfiled</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  title="Delete chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(r.id);
                  }}
                  className="px-1 text-[10px] text-muted-foreground hover:text-destructive"
                >
                  ✕
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function relativeTime(epochSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - epochSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSecs * 1000).toLocaleDateString();
}

// Conversation persistence — wraps tauri-plugin-sql so chats survive
// across app restarts. Schema (migrations in src-tauri/src/lib.rs):
//
//   conversations(id TEXT PK, title TEXT, model_id TEXT, created_at INT, updated_at INT)
//   messages(id INT AUTOINCREMENT, conversation_id TEXT FK, role TEXT,
//            content TEXT, stats_json TEXT, created_at INT)
//
// All timestamps are unix-epoch seconds.

import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:conversations.db";

export interface ConversationRow {
  id: string;
  title: string;
  model_id: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  stats_json: string | null;
  created_at: number;
}

let dbPromise: Promise<Database> | null = null;

async function db(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}

const now = () => Math.floor(Date.now() / 1000);

/** Mint a fresh conversation id. UUIDv4 when available, otherwise a
 *  timestamp+random fallback so we don't fail on older WebViews. */
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create a new conversation row. Returns the id. */
export async function createConversation(args: {
  modelId: string;
  title?: string;
}): Promise<string> {
  const d = await db();
  const id = newId();
  const ts = now();
  const title = args.title ?? "New chat";
  await d.execute(
    "INSERT INTO conversations (id, title, model_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    [id, title, args.modelId, ts, ts],
  );
  return id;
}

/** List conversations, newest first. */
export async function listConversations(): Promise<ConversationRow[]> {
  const d = await db();
  return d.select<ConversationRow[]>(
    "SELECT id, title, model_id, project_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC",
  );
}

/** Load every message in a conversation, oldest first. */
export async function loadMessages(conversationId: string): Promise<MessageRow[]> {
  const d = await db();
  return d.select<MessageRow[]>(
    "SELECT id, conversation_id, role, content, stats_json, created_at FROM messages WHERE conversation_id = $1 ORDER BY id ASC",
    [conversationId],
  );
}

/** Append a message. Bumps the parent conversation's updated_at. */
export async function appendMessage(args: {
  conversationId: string;
  role: MessageRow["role"];
  content: string;
  stats?: unknown;
}): Promise<void> {
  const d = await db();
  const ts = now();
  await d.execute(
    "INSERT INTO messages (conversation_id, role, content, stats_json, created_at) VALUES ($1, $2, $3, $4, $5)",
    [
      args.conversationId,
      args.role,
      args.content,
      args.stats ? JSON.stringify(args.stats) : null,
      ts,
    ],
  );
  await d.execute(
    "UPDATE conversations SET updated_at = $1 WHERE id = $2",
    [ts, args.conversationId],
  );
}

/** Replace a message body (used for assistant streaming: we insert an
 *  empty placeholder then call this on `done` with the full content). */
export async function updateMessage(args: {
  messageId: number;
  content: string;
  stats?: unknown;
}): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE messages SET content = $1, stats_json = $2 WHERE id = $3",
    [args.content, args.stats ? JSON.stringify(args.stats) : null, args.messageId],
  );
}

/** Update a conversation's title (e.g. derived from first user message). */
export async function renameConversation(id: string, title: string): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3",
    [title, now(), id],
  );
}

/** Delete a conversation and all its messages (ON DELETE CASCADE). */
export async function deleteConversation(id: string): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM conversations WHERE id = $1", [id]);
}

/** Full-text search across messages. Tiny + good-enough for now; if
 *  history grows large we'll move to FTS5 virtual tables. Returns
 *  matching conversation rows ordered newest first. */
export async function searchConversations(query: string): Promise<ConversationRow[]> {
  const d = await db();
  const q = `%${query.replace(/[%_]/g, "")}%`;
  return d.select<ConversationRow[]>(
    `SELECT DISTINCT c.id, c.title, c.model_id, c.project_id, c.created_at, c.updated_at
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.title LIKE $1 OR m.content LIKE $1
       ORDER BY c.updated_at DESC
       LIMIT 100`,
    [q],
  );
}

/** Best-effort title derivation: first 60 chars of the first user
 *  message, trimmed at the first newline. */
export function deriveTitle(firstUserMessage: string): string {
  const line = firstUserMessage.split("\n", 1)[0].trim();
  if (line.length === 0) return "New chat";
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

/* -------------------- Projects -------------------- */

export async function listProjects(): Promise<ProjectRow[]> {
  const d = await db();
  return d.select<ProjectRow[]>(
    "SELECT id, name, description, color, created_at, updated_at FROM projects ORDER BY updated_at DESC",
  );
}

export async function createProject(args: {
  name: string;
  description?: string;
  color?: string;
}): Promise<string> {
  const d = await db();
  const id = newId();
  const ts = now();
  await d.execute(
    "INSERT INTO projects (id, name, description, color, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, args.name, args.description ?? null, args.color ?? null, ts, ts],
  );
  return id;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE projects SET name = $1, updated_at = $2 WHERE id = $3",
    [name, now(), id],
  );
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db();
  // ON DELETE CASCADE removes the project's conversations + their messages.
  await d.execute("DELETE FROM projects WHERE id = $1", [id]);
}

export async function assignConversationToProject(
  conversationId: string,
  projectId: string | null,
): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE conversations SET project_id = $1, updated_at = $2 WHERE id = $3",
    [projectId, now(), conversationId],
  );
}

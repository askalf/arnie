import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type Anthropic from "@anthropic-ai/sdk";

export interface SavedSession {
  name: string;
  saved_at: string;
  model: string;
  messages: Anthropic.MessageParam[];
}

function sessionsDir(): string {
  return path.join(os.homedir(), ".arnie", "sessions");
}

function nameToFile(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(sessionsDir(), `${safe}.json`);
}

export async function saveSession(
  name: string,
  model: string,
  messages: Anthropic.MessageParam[],
): Promise<string> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = nameToFile(name);
  const payload: SavedSession = {
    name,
    saved_at: new Date().toISOString(),
    model,
    messages,
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

export async function loadSession(name: string): Promise<SavedSession | null> {
  const file = nameToFile(name);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as SavedSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface SessionInfo {
  name: string;
  saved_at: string;
  model: string;
  turns: number;
  bytes: number;
}

export interface SearchHit {
  session: string;
  saved_at: string;
  message_index: number;
  role: "user" | "assistant";
  snippet: string;
}

export async function searchSessions(query: string, maxResults: number = 30): Promise<SearchHit[]> {
  const all = await listSessions();
  const lower = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const meta of all) {
    if (hits.length >= maxResults) break;
    const session = await loadSession(meta.name);
    if (!session) continue;
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];
      const text = extractText(msg.content).toLowerCase();
      if (!text.includes(lower)) continue;
      const original = extractText(msg.content);
      const idx = original.toLowerCase().indexOf(lower);
      const start = Math.max(0, idx - 60);
      const end = Math.min(original.length, idx + lower.length + 60);
      hits.push({
        session: session.name,
        saved_at: session.saved_at,
        message_index: i,
        role: msg.role,
        snippet: (start > 0 ? "…" : "") + original.slice(start, end).replace(/\s+/g, " ") + (end < original.length ? "…" : ""),
      });
      if (hits.length >= maxResults) break;
    }
  }
  return hits;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") return block.text;
        return "";
      })
      .join("\n");
  }
  return "";
}

export async function loadLastSession(): Promise<SavedSession | null> {
  const all = await listSessions();
  if (all.length === 0) return null;
  return loadSession(all[0].name);
}

export async function listSessions(): Promise<SessionInfo[]> {
  const dir = sessionsDir();
  try {
    const files = await fs.readdir(dir);
    const infos: SessionInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const stat = await fs.stat(path.join(dir, f));
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = JSON.parse(raw) as SavedSession;
        infos.push({
          name: parsed.name,
          saved_at: parsed.saved_at,
          model: parsed.model,
          turns: parsed.messages.filter((m) => m.role === "user").length,
          bytes: stat.size,
        });
      } catch {
        // skip corrupt
      }
    }
    infos.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
    return infos;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

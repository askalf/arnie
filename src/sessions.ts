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

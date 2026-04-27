import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface Settings {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  thinking?: "adaptive" | "disabled";
  compact?: boolean;
  contextEdit?: boolean;
  webSearch?: boolean;
  subagent?: boolean;
  skills?: boolean;
  memory?: boolean;
  permissions?: boolean;
  transcript?: boolean;
  transcriptDir?: string;
  showUsage?: boolean;
  systemExtra?: string;
  statusLine?: boolean;
  markdown?: boolean;
}

function settingsPath(): string {
  return path.join(os.homedir(), ".arnie", "settings.json");
}

export async function loadSettings(): Promise<{ settings: Settings; source: string | null }> {
  const file = settingsPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    return { settings: JSON.parse(raw) as Settings, source: file };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: {}, source: null };
    }
    throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeSettings(settings: Settings): Promise<string> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
  return file;
}

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface McpServerDefinition {
  type?: string;
  name: string;
  url: string;
  authorization_token?: string;
  tool_configuration?: {
    enabled?: boolean;
    allowed_tools?: string[];
  };
}

export interface McpConfig {
  servers: McpServerDefinition[];
  source: string | null;
}

const EMPTY: McpConfig = { servers: [], source: null };

export async function loadMcpConfig(): Promise<McpConfig> {
  const candidates = [
    path.join(process.cwd(), ".arnie", "mcp.json"),
    path.join(os.homedir(), ".arnie", "mcp.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { servers?: McpServerDefinition[] };
      if (Array.isArray(parsed.servers)) {
        const servers = parsed.servers
          .filter((s) => s && typeof s.name === "string" && typeof s.url === "string")
          .map((s) => ({ ...s, type: s.type ?? "url" }));
        return { servers, source: file };
      }
      return { servers: [], source: file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return EMPTY;
}

export function describeMcp(cfg: McpConfig): string {
  if (!cfg.source || cfg.servers.length === 0) return "no mcp servers";
  const names = cfg.servers.map((s) => s.name).join(", ");
  return `${cfg.servers.length} servers: ${names}`;
}

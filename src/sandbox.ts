import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface SandboxConfig {
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  source: string | null;
}

const EMPTY: SandboxConfig = { allowed_read_paths: [], allowed_write_paths: [], source: null };

let active: SandboxConfig = EMPTY;

function expand(p: string): string {
  return path.resolve(p.replace(/^~(?=$|\/|\\)/, os.homedir()));
}

function pathContainedIn(target: string, dir: string): boolean {
  const t = path.resolve(target);
  const d = path.resolve(dir);
  if (t === d) return true;
  const sep = path.sep;
  return t.startsWith(d.endsWith(sep) ? d : d + sep);
}

export async function loadSandbox(): Promise<SandboxConfig> {
  const candidates = [
    path.join(process.cwd(), ".arnie", "sandbox.json"),
    path.join(os.homedir(), ".arnie", "sandbox.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<SandboxConfig>;
      return {
        allowed_read_paths: Array.isArray(parsed.allowed_read_paths) ? parsed.allowed_read_paths.map(expand) : [],
        allowed_write_paths: Array.isArray(parsed.allowed_write_paths) ? parsed.allowed_write_paths.map(expand) : [],
        source: file,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return EMPTY;
}

export function setSandbox(cfg: SandboxConfig): void {
  active = cfg;
}

export function describeSandbox(): string {
  if (!active.source) return "no sandbox restrictions";
  const r = active.allowed_read_paths.length;
  const w = active.allowed_write_paths.length;
  return `${active.source} (read=${r}, write=${w})`;
}

export function checkRead(target: string): { allowed: boolean; reason?: string } {
  if (!active.source || active.allowed_read_paths.length === 0) return { allowed: true };
  const ok = active.allowed_read_paths.some((d) => pathContainedIn(target, d));
  if (ok) return { allowed: true };
  return {
    allowed: false,
    reason: `path ${target} is outside allowed read paths (${active.allowed_read_paths.join(", ")})`,
  };
}

export function checkWrite(target: string): { allowed: boolean; reason?: string } {
  if (!active.source || active.allowed_write_paths.length === 0) return { allowed: true };
  const ok = active.allowed_write_paths.some((d) => pathContainedIn(target, d));
  if (ok) return { allowed: true };
  return {
    allowed: false,
    reason: `path ${target} is outside allowed write paths (${active.allowed_write_paths.join(", ")})`,
  };
}

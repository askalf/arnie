import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface MemoryFile {
  path: string;
  scope: "global" | "project";
  content: string;
}

export async function loadMemoryFiles(): Promise<MemoryFile[]> {
  const candidates: { path: string; scope: "global" | "project" }[] = [
    { path: path.join(os.homedir(), ".arnie", "memory.md"), scope: "global" },
    { path: path.join(process.cwd(), ".arnie", "memory.md"), scope: "project" },
    { path: path.join(process.cwd(), "ARNIE.md"), scope: "project" },
  ];

  const seen = new Set<string>();
  const result: MemoryFile[] = [];
  for (const c of candidates) {
    const resolved = path.resolve(c.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      const content = await fs.readFile(resolved, "utf8");
      if (content.trim().length > 0) {
        result.push({ path: resolved, scope: c.scope, content });
      }
    } catch {
      // missing file is fine
    }
  }
  return result;
}

export function formatMemoryBlock(files: MemoryFile[]): string {
  if (files.length === 0) return "";
  const sections = files.map(
    (f) => `### ${f.scope === "global" ? "Global memory" : "Project memory"} (${f.path})\n\n${f.content.trim()}`,
  );
  return `Persistent memory (loaded from disk; refer to as needed when relevant):\n\n${sections.join("\n\n")}`;
}

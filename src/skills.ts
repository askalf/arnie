import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface Skill {
  name: string;
  scope: "global" | "project";
  path: string;
  description: string;
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  const m = FRONT_MATTER_RE.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
  }
  return { meta, body: m[2] };
}

async function discoverIn(dir: string, scope: "global" | "project"): Promise<Skill[]> {
  const out: Skill[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(dir, e.name, "SKILL.md");
    try {
      const content = await fs.readFile(skillFile, "utf8");
      const { meta, body } = parseFrontMatter(content);
      const description = meta.description || body.split("\n").find((l) => l.trim().length > 0) || "(no description)";
      const name = meta.name || e.name;
      out.push({
        name,
        scope,
        path: skillFile,
        description: description.trim(),
      });
    } catch {
      // missing SKILL.md is fine, just skip
    }
  }
  return out;
}

export async function discoverSkills(): Promise<Skill[]> {
  const globalDir = path.join(os.homedir(), ".arnie", "skills");
  const projectDir = path.join(process.cwd(), ".arnie", "skills");
  const [global, project] = await Promise.all([
    discoverIn(globalDir, "global"),
    discoverIn(projectDir, "project"),
  ]);
  return [...global, ...project];
}

export function formatSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const rows = skills.map((s) => `- **${s.name}** (${s.scope}, ${s.path}): ${s.description}`);
  return [
    "Skills available (loaded on demand — use read_file on the path to read the full skill body):",
    "",
    ...rows,
  ].join("\n");
}

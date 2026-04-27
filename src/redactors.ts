import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface RedactorRule {
  pattern: string;
  replacement?: string;
  reason?: string;
}

export interface RedactorsConfig {
  patterns: { rule: RedactorRule; re: RegExp }[];
  source: string | null;
}

const EMPTY: RedactorsConfig = { patterns: [], source: null };

const DEFAULT_RULES: RedactorRule[] = [
  { pattern: "sk-ant-[A-Za-z0-9_-]{20,}", replacement: "[REDACTED:anthropic-key]", reason: "anthropic api key" },
  { pattern: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED:aws-access-key]", reason: "AWS access key" },
  { pattern: "ghp_[A-Za-z0-9]{36}", replacement: "[REDACTED:github-pat]", reason: "github personal access token" },
  { pattern: "(?i)password\\s*[:=]\\s*\\S+", replacement: "password=[REDACTED]", reason: "password assignment" },
  { pattern: "(?i)api[_-]?key\\s*[:=]\\s*\\S+", replacement: "api_key=[REDACTED]", reason: "api key assignment" },
  { pattern: "Bearer\\s+[A-Za-z0-9._~+/-]+=*", replacement: "Bearer [REDACTED]", reason: "bearer token" },
];

export async function loadRedactors(): Promise<RedactorsConfig> {
  const candidates = [
    path.join(process.cwd(), ".arnie", "redactors.json"),
    path.join(os.homedir(), ".arnie", "redactors.json"),
  ];
  let source: string | null = null;
  let rules: RedactorRule[] = [...DEFAULT_RULES];

  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { rules?: RedactorRule[]; defaults?: boolean };
      if (Array.isArray(parsed.rules)) {
        if (parsed.defaults === false) rules = [];
        rules = [...rules, ...parsed.rules];
      }
      source = file;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const patterns: RedactorsConfig["patterns"] = [];
  for (const r of rules) {
    try {
      const re = new RegExp(r.pattern, "g");
      patterns.push({ rule: r, re });
    } catch {
      // skip invalid
    }
  }
  return { patterns, source };
}

let active: RedactorsConfig = EMPTY;

export function setRedactors(cfg: RedactorsConfig): void {
  active = cfg;
}

export function redact(text: string): { redacted: string; hits: number } {
  if (!text || active.patterns.length === 0) return { redacted: text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const { rule, re } of active.patterns) {
    out = out.replace(re, () => {
      hits += 1;
      return rule.replacement ?? "[REDACTED]";
    });
  }
  return { redacted: out, hits };
}

export function redactorCount(): number {
  return active.patterns.length;
}

export function describeRedactors(): string {
  if (active.patterns.length === 0) return "no redactors";
  return `${active.patterns.length} pattern${active.patterns.length === 1 ? "" : "s"}${active.source ? ` (${active.source})` : " (defaults)"}`;
}

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import { log } from "../log.js";

const MAX_MATCHES = 200;
const MAX_FILE_SIZE = 10_000_000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
]);

export interface GrepInput {
  pattern: string;
  path?: string;
  case_insensitive?: boolean;
  max_results?: number;
  context?: number;
  glob?: string;
  literal?: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  context_before?: string[];
  context_after?: string[];
}

export interface GrepResult {
  ok: boolean;
  pattern: string;
  matches: GrepMatch[];
  files_scanned: number;
  truncated: boolean;
  error?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += "[^/\\\\]*";
    else if (c === "?") re += ".";
    else if (c === ".") re += "\\.";
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

async function* walk(dir: string, globRe: RegExp | null): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, globRe);
    } else if (e.isFile()) {
      if (globRe && !globRe.test(e.name)) continue;
      yield full;
    }
  }
}

async function searchFile(
  file: string,
  pattern: RegExp,
  ctx: number,
  out: GrepMatch[],
  remaining: number,
): Promise<number> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return 0;
  }
  if (stat.size > MAX_FILE_SIZE) return 0;

  const stream = fsSync.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const buffer: string[] = [];
  let lineNum = 0;
  let matchesFound = 0;

  for await (const line of rl) {
    lineNum += 1;
    buffer.push(line);
    if (buffer.length > ctx + 1) buffer.shift();

    if (pattern.test(line)) {
      const before = ctx > 0 ? buffer.slice(0, -1) : undefined;
      const after: string[] = [];

      out.push({
        file,
        line: lineNum,
        text: line,
        context_before: before && before.length > 0 ? before : undefined,
        context_after: undefined,
      });
      matchesFound += 1;

      if (ctx > 0) {
        let collected = 0;
        const matchIdx = out.length - 1;
        for await (const next of rl) {
          lineNum += 1;
          after.push(next);
          buffer.push(next);
          if (buffer.length > ctx + 1) buffer.shift();
          collected += 1;
          if (pattern.test(next)) {
            out[matchIdx].context_after = after.slice(0, collected - 1);
            out.push({
              file,
              line: lineNum,
              text: next,
              context_before: ctx > 0 ? buffer.slice(0, -1) : undefined,
              context_after: undefined,
            });
            matchesFound += 1;
            after.length = 0;
            collected = 0;
            if (matchesFound >= remaining) break;
          }
          if (collected >= ctx) {
            out[matchIdx].context_after = after.slice();
            after.length = 0;
            break;
          }
        }
        if (after.length > 0) out[matchIdx].context_after = after.slice();
      }
      if (matchesFound >= remaining) break;
    }
  }
  return matchesFound;
}

export async function runGrep(input: GrepInput): Promise<GrepResult> {
  const root = path.resolve(input.path ?? ".");
  const max = Math.min(input.max_results ?? MAX_MATCHES, MAX_MATCHES);
  const ctx = Math.max(0, Math.min(input.context ?? 0, 5));
  const flags = input.case_insensitive ? "i" : "";

  log();
  log(chalk.cyan("grep ") + chalk.white(`"${input.pattern}"`) + chalk.dim(` in ${root}`));

  let pattern: RegExp;
  try {
    const src = input.literal ? escapeRegex(input.pattern) : input.pattern;
    pattern = new RegExp(src, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, pattern: input.pattern, matches: [], files_scanned: 0, truncated: false, error: `invalid regex: ${msg}` };
  }

  const globRe = input.glob ? globToRegex(input.glob) : null;
  const matches: GrepMatch[] = [];
  let filesScanned = 0;

  try {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      filesScanned = 1;
      await searchFile(root, pattern, ctx, matches, max);
    } else {
      for await (const f of walk(root, globRe)) {
        filesScanned += 1;
        const remaining = max - matches.length;
        if (remaining <= 0) break;
        try {
          await searchFile(f, pattern, ctx, matches, remaining);
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, pattern: input.pattern, matches: [], files_scanned: filesScanned, truncated: false, error: msg };
  }

  const truncated = matches.length >= max;
  log(chalk.dim(`  ${matches.length} match${matches.length === 1 ? "" : "es"} in ${filesScanned} file${filesScanned === 1 ? "" : "s"}`));
  return {
    ok: true,
    pattern: input.pattern,
    matches: matches.slice(0, max),
    files_scanned: filesScanned,
    truncated,
  };
}

export const GREP_TOOL_DEFINITION = {
  name: "grep",
  description:
    "Search for a regex pattern across files. Recursively walks the path (skipping node_modules/.git/dist/etc). Use literal=true to escape regex metacharacters. glob like '*.log' filters by filename. context=N includes N lines before/after. Use this for triaging logs or finding error strings — far better than piping cat through grep via shell.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "Regex pattern (or literal string with literal=true)." },
      path: { type: "string", description: "File or directory to search. Default: current working directory." },
      case_insensitive: { type: "boolean", description: "Case-insensitive match (default false)." },
      max_results: { type: "integer", description: `Cap on matches (default 200, max ${MAX_MATCHES}).`, minimum: 1 },
      context: { type: "integer", description: "Lines of context before/after each match (max 5, default 0).", minimum: 0, maximum: 5 },
      glob: { type: "string", description: "Filename glob like '*.log' or 'error*'. Optional." },
      literal: { type: "boolean", description: "Treat pattern as literal string, not regex (default false)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

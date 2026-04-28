import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import { log } from "../log.js";
import { checkRead } from "../sandbox.js";

const DEFAULT_LINES = 100;
const MAX_LINES = 5000;
const MAX_BYTES = 5_000_000;

export interface TailLogInput {
  path: string;
  lines?: number;
  filter?: string;
  case_insensitive?: boolean;
}

export interface TailLogResult {
  ok: boolean;
  path: string;
  lines_requested: number;
  lines_returned: number;
  filter?: string;
  content?: string;
  error?: string;
}

async function tailFile(file: string, n: number, filter?: RegExp): Promise<string[]> {
  const stat = await fs.stat(file);
  const startByte = stat.size > MAX_BYTES ? stat.size - MAX_BYTES : 0;
  const stream = fsSync.createReadStream(file, { encoding: "utf8", start: startByte });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const buffer: string[] = [];
  for await (const line of rl) {
    if (filter && !filter.test(line)) continue;
    buffer.push(line);
    if (buffer.length > n) buffer.shift();
  }
  return buffer;
}

export async function runTailLog(input: TailLogInput): Promise<TailLogResult> {
  const resolved = path.resolve(input.path);
  const n = Math.min(input.lines ?? DEFAULT_LINES, MAX_LINES);

  log();
  log(chalk.cyan("tail ") + chalk.white(resolved) + chalk.dim(` (last ${n} lines${input.filter ? `, filter=${input.filter}` : ""})`));

  const sb = checkRead(resolved);
  if (!sb.allowed) {
    log(chalk.red(`  ✕ sandbox: ${sb.reason}`));
    return { ok: false, path: resolved, lines_requested: n, lines_returned: 0, error: `sandbox denied: ${sb.reason}` };
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  error: ${msg}`));
    return { ok: false, path: resolved, lines_requested: n, lines_returned: 0, error: msg };
  }
  if (stat.isDirectory()) {
    return { ok: false, path: resolved, lines_requested: n, lines_returned: 0, error: "Path is a directory." };
  }

  let filter: RegExp | undefined;
  if (input.filter) {
    try {
      filter = new RegExp(input.filter, input.case_insensitive ? "i" : "");
    } catch (err) {
      return {
        ok: false,
        path: resolved,
        lines_requested: n,
        lines_returned: 0,
        error: `invalid filter regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const lines = await tailFile(resolved, n, filter);
    log(chalk.dim(`  ${lines.length} line${lines.length === 1 ? "" : "s"}`));
    return {
      ok: true,
      path: resolved,
      lines_requested: n,
      lines_returned: lines.length,
      filter: input.filter,
      content: lines.join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  error: ${msg}`));
    return { ok: false, path: resolved, lines_requested: n, lines_returned: 0, error: msg };
  }
}

export const TAIL_LOG_TOOL_DEFINITION = {
  name: "tail_log",
  description:
    "Read the last N lines of a file (default 100, max 5000), optionally filtered by a regex. Use this for log triage instead of read_file when you only need the recent end of a file. Cheaper than reading the whole log when only the tail matters. Sandbox-aware.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Path to the log file." },
      lines: { type: "integer", description: `Number of trailing lines to return (default ${DEFAULT_LINES}, max ${MAX_LINES}).`, minimum: 1, maximum: MAX_LINES },
      filter: { type: "string", description: "Optional regex filter; only matching lines counted toward the tail." },
      case_insensitive: { type: "boolean", description: "Case-insensitive filter (default false)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

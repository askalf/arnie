import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { log } from "../log.js";
import { checkRead } from "../sandbox.js";

const MAX_ENTRIES = 500;

export interface ListDirInput {
  path: string;
}

export interface ListDirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
}

export interface ListDirResult {
  ok: boolean;
  path: string;
  entries?: ListDirEntry[];
  total?: number;
  truncated?: boolean;
  error?: string;
}

export async function runListDir(input: ListDirInput): Promise<ListDirResult> {
  const resolved = path.resolve(input.path);
  log();
  log(chalk.cyan("ls ") + chalk.white(resolved));

  const sb = checkRead(resolved);
  if (!sb.allowed) {
    log(chalk.red(`  ✕ sandbox: ${sb.reason}`));
    return { ok: false, path: resolved, error: `sandbox denied: ${sb.reason}` };
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        path: resolved,
        error: "Path is not a directory.",
      };
    }

    const dirents = await fs.readdir(resolved, { withFileTypes: true });
    const entries: ListDirEntry[] = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      let type: ListDirEntry["type"];
      if (d.isFile()) type = "file";
      else if (d.isDirectory()) type = "directory";
      else if (d.isSymbolicLink()) type = "symlink";
      else type = "other";

      let size = 0;
      try {
        const childStat = await fs.lstat(path.join(resolved, d.name));
        size = childStat.size;
      } catch {
        size = 0;
      }
      entries.push({ name: d.name, type, size });
    }

    log(chalk.dim(`  ${dirents.length} entries`));
    return {
      ok: true,
      path: resolved,
      entries,
      total: dirents.length,
      truncated: dirents.length > MAX_ENTRIES,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  error: ${message}`));
    return {
      ok: false,
      path: resolved,
      error: message,
    };
  }
}

export const LIST_DIR_TOOL_DEFINITION = {
  name: "list_dir",
  description:
    "List the contents of a directory. Returns entries with their type (file/directory/symlink) and size. Truncates after 500 entries.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the directory.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

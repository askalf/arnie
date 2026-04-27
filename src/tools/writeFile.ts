import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { confirm } from "../confirm.js";

const MAX_PREVIEW = 800;

export interface WriteFileInput {
  path: string;
  content: string;
  mode?: "overwrite" | "create_only";
  reason?: string;
}

export interface WriteFileResult {
  ok: boolean;
  path: string;
  bytes_written?: number;
  error?: string;
  cancelled?: boolean;
}

function preview(content: string): string {
  if (content.length <= MAX_PREVIEW) return content;
  return content.slice(0, MAX_PREVIEW) + `\n... [+${content.length - MAX_PREVIEW} chars]`;
}

export async function runWriteFile(input: WriteFileInput): Promise<WriteFileResult> {
  const resolved = path.resolve(input.path);
  const mode = input.mode ?? "overwrite";

  console.log();
  console.log(chalk.cyan("write ") + chalk.white(resolved) + chalk.dim(` (${input.content.length} bytes, mode=${mode})`));
  if (input.reason) console.log(chalk.dim(`  reason: ${input.reason}`));

  let exists = false;
  try {
    const stat = await fs.stat(resolved);
    exists = stat.isFile();
    if (stat.isDirectory()) {
      return {
        ok: false,
        path: resolved,
        error: "Path is a directory.",
      };
    }
  } catch {
    exists = false;
  }

  if (exists && mode === "create_only") {
    return {
      ok: false,
      path: resolved,
      error: "File exists and mode is create_only.",
    };
  }

  console.log(chalk.dim("  --- preview ---"));
  console.log(
    preview(input.content)
      .split("\n")
      .map((l) => chalk.dim("  | ") + l)
      .join("\n"),
  );
  console.log(chalk.dim("  --- end preview ---"));

  const verb = exists ? "Overwrite" : "Create";
  const ok = await confirm(`  ${verb} ${resolved}?`);
  if (!ok) {
    console.log(chalk.dim("  skipped by user"));
    return {
      ok: false,
      path: resolved,
      cancelled: true,
      error: "User declined the write. Try a different approach or ask the user what they would prefer.",
    };
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, input.content, "utf8");
    const bytes = Buffer.byteLength(input.content, "utf8");
    console.log(chalk.green(`  wrote ${bytes} bytes`));
    return {
      ok: true,
      path: resolved,
      bytes_written: bytes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  error: ${message}`));
    return {
      ok: false,
      path: resolved,
      error: message,
    };
  }
}

export const WRITE_FILE_TOOL_DEFINITION = {
  name: "write_file",
  description:
    "Write content to a file on disk. Always requires user confirmation. Use mode=create_only to fail if the file already exists; default is overwrite. Provide a brief reason. Parent directories are created automatically.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file.",
      },
      content: {
        type: "string",
        description: "Full content to write (UTF-8).",
      },
      mode: {
        type: "string",
        enum: ["overwrite", "create_only"],
        description: "overwrite (default) or create_only (fails if file exists).",
      },
      reason: {
        type: "string",
        description: "One-line explanation of why this write is needed.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

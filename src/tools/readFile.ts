import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

const MAX_FILE_BYTES = 200_000;

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface ReadFileResult {
  ok: boolean;
  path: string;
  bytes: number;
  content?: string;
  truncated?: boolean;
  error?: string;
}

export async function runReadFile(input: ReadFileInput): Promise<ReadFileResult> {
  const resolved = path.resolve(input.path);
  console.log();
  console.log(chalk.cyan("read ") + chalk.white(resolved));

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return {
        ok: false,
        path: resolved,
        bytes: 0,
        error: "Path is a directory. Use the shell tool with `ls` or `Get-ChildItem` to list contents.",
      };
    }

    const buf = await fs.readFile(resolved);
    let content = buf.toString("utf8");
    let truncated = false;

    if (input.start_line !== undefined || input.end_line !== undefined) {
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, input.start_line ?? 1) - 1;
      const end = Math.min(lines.length, input.end_line ?? lines.length);
      content = lines.slice(start, end).join("\n");
    }

    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      const sliced = Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8");
      content = `${sliced}\n\n... [truncated; file is ${stat.size} bytes total. Use start_line/end_line to read specific ranges.]`;
      truncated = true;
    }

    console.log(chalk.dim(`  ${stat.size} bytes`));
    return {
      ok: true,
      path: resolved,
      bytes: stat.size,
      content,
      truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  error: ${message}`));
    return {
      ok: false,
      path: resolved,
      bytes: 0,
      error: message,
    };
  }
}

export const READ_FILE_TOOL_DEFINITION = {
  name: "read_file",
  description:
    "Read a file from the user's local filesystem. Use for inspecting logs, configs, scripts, etc. Optional start_line/end_line (1-indexed, inclusive) to read a slice of a large file. Files over 200KB are truncated.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file.",
      },
      start_line: {
        type: "integer",
        description: "1-indexed start line. Optional.",
        minimum: 1,
      },
      end_line: {
        type: "integer",
        description: "1-indexed end line, inclusive. Optional.",
        minimum: 1,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

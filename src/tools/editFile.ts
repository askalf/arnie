import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { confirm } from "../confirm.js";

const MAX_PREVIEW_LINES = 12;

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  reason?: string;
}

export interface EditFileResult {
  ok: boolean;
  path: string;
  replacements?: number;
  error?: string;
  cancelled?: boolean;
}

function diffPreview(before: string, after: string, oldStr: string): string {
  const idx = before.indexOf(oldStr);
  if (idx === -1) return "(diff: pattern not found)";
  const startBefore = before.lastIndexOf("\n", idx) + 1;
  const beforeLine = before.slice(0, idx).split("\n").length;
  const oldLines = oldStr.split("\n");
  const newLines = after.slice(startBefore).split("\n").slice(0, MAX_PREVIEW_LINES).join("\n");
  const oldPreview = oldLines.slice(0, MAX_PREVIEW_LINES).join("\n");
  return [
    chalk.red(`-${"-".repeat(40)} (line ${beforeLine})`),
    ...oldPreview.split("\n").map((l) => chalk.red(`- ${l}`)),
    chalk.green(`+${"-".repeat(40)}`),
    ...newLines.split("\n").map((l) => chalk.green(`+ ${l}`)),
  ].join("\n");
}

export async function runEditFile(input: EditFileInput): Promise<EditFileResult> {
  const resolved = path.resolve(input.path);
  console.log();
  console.log(chalk.cyan("edit ") + chalk.white(resolved));
  if (input.reason) console.log(chalk.dim(`  reason: ${input.reason}`));

  if (input.old_string === input.new_string) {
    return { ok: false, path: resolved, error: "old_string and new_string are identical." };
  }

  let original: string;
  try {
    original = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  error: ${msg}`));
    return { ok: false, path: resolved, error: msg };
  }

  const occurrences = original.split(input.old_string).length - 1;
  if (occurrences === 0) {
    return { ok: false, path: resolved, error: "old_string not found in file." };
  }
  if (occurrences > 1 && !input.replace_all) {
    return {
      ok: false,
      path: resolved,
      error: `old_string occurs ${occurrences} times — provide more surrounding context to make it unique, or set replace_all=true.`,
    };
  }

  let updated: string;
  let replacements: number;
  if (input.replace_all) {
    updated = original.split(input.old_string).join(input.new_string);
    replacements = occurrences;
  } else {
    updated = original.replace(input.old_string, input.new_string);
    replacements = 1;
  }

  console.log(chalk.dim(`  --- diff preview (${replacements} replacement${replacements === 1 ? "" : "s"}) ---`));
  console.log(diffPreview(original, updated, input.old_string));
  console.log(chalk.dim("  --- end preview ---"));

  const ok = await confirm("  Apply this edit?");
  if (!ok) {
    console.log(chalk.dim("  skipped by user"));
    return {
      ok: false,
      path: resolved,
      cancelled: true,
      error: "User declined the edit.",
    };
  }

  try {
    await fs.writeFile(resolved, updated, "utf8");
    console.log(chalk.green(`  applied ${replacements} replacement${replacements === 1 ? "" : "s"}`));
    return { ok: true, path: resolved, replacements };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  error: ${msg}`));
    return { ok: false, path: resolved, error: msg };
  }
}

export const EDIT_FILE_TOOL_DEFINITION = {
  name: "edit_file",
  description:
    "Edit a file by replacing an exact string. Reads the file, locates old_string (must be unique unless replace_all=true), substitutes new_string, shows a diff preview, and asks the user to confirm. Prefer this over write_file when you're modifying part of an existing file — it avoids accidentally truncating content. Always read the file first to get the exact bytes you intend to replace.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file." },
      old_string: { type: "string", description: "Exact text to find. Must include enough context to be unique unless replace_all=true." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false; default forces uniqueness)." },
      reason: { type: "string", description: "One-line explanation." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

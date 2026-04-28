import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { confirm } from "../confirm.js";
import { log } from "../log.js";
import { checkRead, checkWrite } from "../sandbox.js";

export interface ApplyPatchInput {
  path: string;
  patch: string;
  reason?: string;
}

export interface ApplyPatchResult {
  ok: boolean;
  path: string;
  hunks_applied?: number;
  hunks_total?: number;
  error?: string;
  cancelled?: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { type: " " | "+" | "-"; text: string }[];
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function parseUnifiedDiff(patch: string): { hunks: Hunk[]; error?: string } {
  const lines = patch.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let i = 0;
  // Skip "---"/"+++"  file headers if present
  while (i < lines.length && (lines[i].startsWith("---") || lines[i].startsWith("+++") || lines[i].startsWith("diff "))) {
    i += 1;
  }
  while (i < lines.length) {
    const header = lines[i];
    if (header.trim().length === 0) {
      i += 1;
      continue;
    }
    const m = HUNK_HEADER_RE.exec(header);
    if (!m) {
      return { hunks: [], error: `expected hunk header, got: ${header}` };
    }
    const hunk: Hunk = {
      oldStart: Number(m[1]),
      oldCount: m[2] ? Number(m[2]) : 1,
      newStart: Number(m[3]),
      newCount: m[4] ? Number(m[4]) : 1,
      lines: [],
    };
    i += 1;
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i])) {
      const line = lines[i];
      if (line === "" && i === lines.length - 1) {
        // trailing blank line at EOF — skip
        i += 1;
        continue;
      }
      const type = line[0];
      if (type !== "+" && type !== "-" && type !== " ") {
        return { hunks: [], error: `unexpected line in hunk: ${line}` };
      }
      hunk.lines.push({ type, text: line.slice(1) });
      i += 1;
    }
    hunks.push(hunk);
  }
  return { hunks };
}

function applyHunks(original: string, hunks: Hunk[]): { ok: boolean; result?: string; failedHunk?: number; reason?: string } {
  const origLines = original.split("\n");
  let outLines: string[] = [];
  let cursor = 0;

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const target = hunk.oldStart - 1;

    if (target < cursor) {
      return { ok: false, failedHunk: h, reason: `hunk ${h + 1} oldStart=${hunk.oldStart} overlaps prior region (cursor=${cursor})` };
    }
    // Copy unchanged lines up to the hunk start
    while (cursor < target) {
      outLines.push(origLines[cursor]);
      cursor += 1;
    }

    for (const l of hunk.lines) {
      if (l.type === " ") {
        if (origLines[cursor] !== l.text) {
          return { ok: false, failedHunk: h, reason: `context mismatch at line ${cursor + 1} of original (expected '${l.text}', got '${origLines[cursor]}')` };
        }
        outLines.push(l.text);
        cursor += 1;
      } else if (l.type === "-") {
        if (origLines[cursor] !== l.text) {
          return { ok: false, failedHunk: h, reason: `delete mismatch at line ${cursor + 1} of original (expected '${l.text}', got '${origLines[cursor]}')` };
        }
        cursor += 1;
      } else if (l.type === "+") {
        outLines.push(l.text);
      }
    }
  }
  // Copy remaining lines
  while (cursor < origLines.length) {
    outLines.push(origLines[cursor]);
    cursor += 1;
  }
  return { ok: true, result: outLines.join("\n") };
}

function preview(patch: string): string {
  return patch
    .split("\n")
    .slice(0, 40)
    .map((l) => {
      if (l.startsWith("+")) return chalk.green(l);
      if (l.startsWith("-")) return chalk.red(l);
      if (l.startsWith("@@")) return chalk.dim(l);
      return l;
    })
    .join("\n");
}

export async function runApplyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  const resolved = path.resolve(input.path);
  log();
  log(chalk.cyan("apply_patch ") + chalk.white(resolved));
  if (input.reason) log(chalk.dim(`  reason: ${input.reason}`));

  const r = checkRead(resolved);
  if (!r.allowed) {
    log(chalk.red(`  ✕ sandbox (read): ${r.reason}`));
    return { ok: false, path: resolved, error: `sandbox denied: ${r.reason}` };
  }
  const w = checkWrite(resolved);
  if (!w.allowed) {
    log(chalk.red(`  ✕ sandbox (write): ${w.reason}`));
    return { ok: false, path: resolved, error: `sandbox denied: ${w.reason}` };
  }

  let original: string;
  try {
    original = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  error: ${msg}`));
    return { ok: false, path: resolved, error: msg };
  }

  const parsed = parseUnifiedDiff(input.patch);
  if (parsed.error || parsed.hunks.length === 0) {
    return { ok: false, path: resolved, error: parsed.error ?? "no hunks in patch" };
  }

  const applied = applyHunks(original, parsed.hunks);
  if (!applied.ok) {
    log(chalk.red(`  hunk ${applied.failedHunk! + 1} failed: ${applied.reason}`));
    return {
      ok: false,
      path: resolved,
      hunks_total: parsed.hunks.length,
      error: `hunk ${applied.failedHunk! + 1} failed: ${applied.reason}. Re-read the file and regenerate the patch with current context lines.`,
    };
  }

  log(chalk.dim(`  --- patch preview (${parsed.hunks.length} hunk${parsed.hunks.length === 1 ? "" : "s"}) ---`));
  log(
    preview(input.patch)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  log(chalk.dim("  --- end preview ---"));

  const ok = await confirm("  Apply this patch?");
  if (!ok) {
    log(chalk.dim("  skipped by user"));
    return {
      ok: false,
      path: resolved,
      cancelled: true,
      error: "User declined the patch.",
    };
  }

  try {
    await fs.writeFile(resolved, applied.result!, "utf8");
    log(chalk.green(`  applied ${parsed.hunks.length} hunk${parsed.hunks.length === 1 ? "" : "s"}`));
    return { ok: true, path: resolved, hunks_applied: parsed.hunks.length, hunks_total: parsed.hunks.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  error: ${msg}`));
    return { ok: false, path: resolved, error: msg };
  }
}

export const APPLY_PATCH_TOOL_DEFINITION = {
  name: "apply_patch",
  description:
    "Apply a unified diff patch to a file. The patch must contain @@ hunk headers with correct line numbers and matching context lines. Reads the file, validates every hunk against the current content (context, deletions), shows a colored preview, and asks the user to confirm. Use this for multi-hunk changes (4+ replacements in a file) where calling edit_file repeatedly would be tedious. The 'patch' field is the standard unified-diff body — file headers (---/+++) are optional. If a hunk fails to apply, re-read the file with read_file and regenerate the patch with fresh context.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file." },
      patch: { type: "string", description: "Unified-diff body. Must include @@ hunk headers." },
      reason: { type: "string", description: "One-line explanation of what this patch does." },
    },
    required: ["path", "patch"],
    additionalProperties: false,
  },
};

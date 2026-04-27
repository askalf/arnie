import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 200_000;

const IMAGE_EXTS: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface ParsedInput {
  text: string;
  blocks: Anthropic.ContentBlockParam[];
  attachments: { path: string; type: "image" | "text"; bytes: number }[];
  errors: string[];
}

const ATTACH_RE = /^attach\s+(.+)$/im;
const ATTACH_BLOCK_RE = /^attach\s+(.+)$/gim;

export async function parseInput(rawText: string): Promise<ParsedInput> {
  const result: ParsedInput = { text: rawText, blocks: [], attachments: [], errors: [] };

  const matches: { full: string; pathArg: string }[] = [];
  let m: RegExpExecArray | null;
  ATTACH_BLOCK_RE.lastIndex = 0;
  while ((m = ATTACH_BLOCK_RE.exec(rawText)) !== null) {
    matches.push({ full: m[0], pathArg: m[1].trim() });
  }

  if (matches.length === 0) {
    result.blocks.push({ type: "text", text: rawText });
    return result;
  }

  let remainingText = rawText;
  for (const match of matches) {
    const target = path.resolve(match.pathArg);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        result.errors.push(`attach failed: ${target} is not a file`);
        continue;
      }
      const ext = path.extname(target).toLowerCase();
      const mime = IMAGE_EXTS[ext];
      if (mime) {
        if (stat.size > MAX_IMAGE_BYTES) {
          result.errors.push(`attach failed: ${target} exceeds 8MB limit`);
          continue;
        }
        const data = (await fs.readFile(target)).toString("base64");
        result.blocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data },
        });
        result.attachments.push({ path: target, type: "image", bytes: stat.size });
        remainingText = remainingText.replace(match.full, `[attached image: ${path.basename(target)}]`);
      } else {
        if (stat.size > MAX_TEXT_BYTES) {
          result.errors.push(`attach failed: ${target} exceeds 200KB limit (use read_file for larger files)`);
          continue;
        }
        const text = await fs.readFile(target, "utf8");
        result.blocks.push({
          type: "text",
          text: `--- attached file: ${target} ---\n${text}\n--- end of ${path.basename(target)} ---`,
        });
        result.attachments.push({ path: target, type: "text", bytes: stat.size });
        remainingText = remainingText.replace(match.full, `[attached: ${path.basename(target)}]`);
      }
    } catch (err) {
      result.errors.push(`attach failed: ${match.pathArg} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const trimmed = remainingText.trim();
  if (trimmed.length > 0) {
    result.blocks.unshift({ type: "text", text: remainingText });
  }
  result.text = remainingText;
  return result;
}

export function hasAttachDirective(input: string): boolean {
  return ATTACH_RE.test(input);
}

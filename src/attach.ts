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
// @ references: matches @path tokens. Path can contain letters, digits, slash,
// backslash, dot, dash, underscore, colon (Windows drive letters), and *,?,[
// for glob patterns. Doesn't match emails — requires a non-@ char before.
const AT_REF_RE = /(^|\s)@([A-Za-z]:[\\/][^\s@]*|[\w./\\*?[\]-][\w./\\:*?[\]-]*)/g;
const MAX_GLOB_MATCHES = 50;

function isGlob(s: string): boolean {
  return /[*?[]/.test(s);
}

function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/" || glob[i + 1] === "\\") i += 1;
      } else {
        re += "[^/\\\\]*";
      }
    } else if (c === "?") re += ".";
    else if (c === ".") re += "\\.";
    else if (c === "[" || c === "]") re += c;
    else if ("\\/^$|+(){}".includes(c)) re += "\\" + c;
    else re += c;
  }
  re += "$";
  return new RegExp(re);
}

async function expandGlob(pattern: string): Promise<string[]> {
  const abs = path.resolve(pattern);
  // Find first segment with a glob char
  const norm = abs.replace(/\\/g, "/");
  const segs = norm.split("/");
  let baseIdx = 0;
  for (let i = 0; i < segs.length; i++) {
    if (isGlob(segs[i])) {
      baseIdx = i;
      break;
    }
    baseIdx = i + 1;
  }
  if (baseIdx >= segs.length) return [];

  const base = segs.slice(0, baseIdx).join("/") || "/";
  const rest = segs.slice(baseIdx).join("/");
  const re = globToRegex(rest);
  const results: string[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    if (results.length >= MAX_GLOB_MATCHES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_GLOB_MATCHES) return;
      const full = path.join(dir, e.name);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isFile()) {
        if (re.test(rel)) results.push(full);
      }
    }
  }

  await walk(base, "");
  return results;
}

export async function parseInput(rawText: string): Promise<ParsedInput> {
  const result: ParsedInput = { text: rawText, blocks: [], attachments: [], errors: [] };

  const matches: { full: string; pathArg: string }[] = [];
  let m: RegExpExecArray | null;
  ATTACH_BLOCK_RE.lastIndex = 0;
  while ((m = ATTACH_BLOCK_RE.exec(rawText)) !== null) {
    matches.push({ full: m[0], pathArg: m[1].trim() });
  }

  // @file references — attach if path exists, or expand globs.
  AT_REF_RE.lastIndex = 0;
  while ((m = AT_REF_RE.exec(rawText)) !== null) {
    const pathArg = m[2];
    if (isGlob(pathArg)) {
      const expanded = await expandGlob(pathArg);
      if (expanded.length > 0) {
        for (const f of expanded) {
          matches.push({ full: `@${pathArg}`, pathArg: f });
        }
      } else {
        result.errors.push(`@${pathArg}: no files matched glob`);
      }
      continue;
    }
    const resolved = path.resolve(pathArg);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) {
        matches.push({ full: `@${pathArg}`, pathArg });
      }
    } catch {
      // not a real file — leave it alone
    }
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

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
const AT_URL_RE = /(^|\s)@(https?:\/\/[^\s@]+)/g;
const MAX_GLOB_MATCHES = 50;
const MAX_URL_BYTES = 2 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 15_000;

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

async function fetchUrl(url: string): Promise<{ kind: "image"; mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string; bytes: number } | { kind: "text"; text: string; bytes: number } | { kind: "error"; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!resp.ok) {
      return { kind: "error", error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_URL_BYTES) {
      return { kind: "error", error: `response is ${buf.length} bytes — exceeds ${MAX_URL_BYTES} cap` };
    }
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (ct.startsWith("image/")) {
      const m = ct.match(/image\/(jpeg|jpg|png|gif|webp)/);
      if (!m) return { kind: "error", error: `unsupported image type: ${ct}` };
      const mime = (m[1] === "jpg" ? "jpeg" : m[1]) as "jpeg" | "png" | "gif" | "webp";
      return { kind: "image", mime: `image/${mime}` as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: buf.toString("base64"), bytes: buf.length };
    }
    return { kind: "text", text: buf.toString("utf8"), bytes: buf.length };
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function parseInput(rawText: string): Promise<ParsedInput> {
  const result: ParsedInput = { text: rawText, blocks: [], attachments: [], errors: [] };

  const matches: { full: string; pathArg: string }[] = [];
  let m: RegExpExecArray | null;
  ATTACH_BLOCK_RE.lastIndex = 0;
  while ((m = ATTACH_BLOCK_RE.exec(rawText)) !== null) {
    matches.push({ full: m[0], pathArg: m[1].trim() });
  }

  // @URL references — fetched and attached as image or text blocks
  const urlBlocks: Anthropic.ContentBlockParam[] = [];
  let remainingText = rawText;
  AT_URL_RE.lastIndex = 0;
  const urlMatches: { full: string; url: string }[] = [];
  while ((m = AT_URL_RE.exec(rawText)) !== null) {
    urlMatches.push({ full: `@${m[2]}`, url: m[2] });
  }
  for (const u of urlMatches) {
    const r = await fetchUrl(u.url);
    if (r.kind === "error") {
      result.errors.push(`@${u.url}: ${r.error}`);
      continue;
    }
    if (r.kind === "image") {
      urlBlocks.push({
        type: "image",
        source: { type: "base64", media_type: r.mime, data: r.data },
      });
      result.attachments.push({ path: u.url, type: "image", bytes: r.bytes });
      remainingText = remainingText.replace(u.full, `[fetched image: ${u.url}]`);
    } else {
      urlBlocks.push({
        type: "text",
        text: `--- fetched URL: ${u.url} ---\n${r.text.slice(0, MAX_TEXT_BYTES)}\n--- end of ${u.url} ---`,
      });
      result.attachments.push({ path: u.url, type: "text", bytes: r.bytes });
      remainingText = remainingText.replace(u.full, `[fetched: ${u.url}]`);
    }
  }

  // @file references — attach if path exists, or expand globs.
  AT_REF_RE.lastIndex = 0;
  while ((m = AT_REF_RE.exec(rawText)) !== null) {
    const pathArg = m[2];
    // skip URLs — already handled above
    if (/^https?:\/\//.test(pathArg)) continue;
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

  if (matches.length === 0 && urlBlocks.length === 0) {
    result.blocks.push({ type: "text", text: rawText });
    return result;
  }

  // URL blocks come first; file attaches and remaining text follow.
  // Each file is opened once and statted through the handle so the type
  // check and the read both target the same inode — closes the symlink-
  // swap TOCTOU window between `fs.stat(p)` and `fs.readFile(p)`.
  for (const match of matches) {
    const target = path.resolve(match.pathArg);
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(target, "r");
      const stat = await fh.stat();
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
        const data = (await fh.readFile()).toString("base64");
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
        const text = (await fh.readFile()).toString("utf8");
        result.blocks.push({
          type: "text",
          text: `--- attached file: ${target} ---\n${text}\n--- end of ${path.basename(target)} ---`,
        });
        result.attachments.push({ path: target, type: "text", bytes: stat.size });
        remainingText = remainingText.replace(match.full, `[attached: ${path.basename(target)}]`);
      }
    } catch (err) {
      result.errors.push(`attach failed: ${match.pathArg} — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await fh?.close();
    }
  }

  // Prepend URL blocks before file blocks
  if (urlBlocks.length > 0) {
    result.blocks.unshift(...urlBlocks);
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

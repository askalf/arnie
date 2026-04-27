import readline from "node:readline";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

let sharedRl: readline.Interface | null = null;
const lineQueue: string[] = [];
const waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];
let stdinClosed = false;
let isTty = false;
let historyPath: string | null = null;

const SLASH_COMMANDS = [
  "/help",
  "/usage",
  "/clear",
  "/clear --summary",
  "/tools",
  "/jobs",
  "/jobs --watch",
  "/skills",
  "/memory",
  "/remember",
  "/cd",
  "/save",
  "/load",
  "/list",
  "/find",
  "/export",
  "/plan",
  "/settings",
  "/profile",
  "/exit",
];

function pathCompleter(prefix: string): string[] {
  try {
    const dir = prefix.endsWith("/") || prefix.endsWith("\\") ? prefix : path.dirname(prefix);
    const base = prefix.endsWith("/") || prefix.endsWith("\\") ? "" : path.basename(prefix);
    const search = dir === "" ? "." : dir;
    const entries = fsSync.readdirSync(search, { withFileTypes: true });
    return entries
      .filter((e) => e.name.startsWith(base))
      .map((e) => path.join(dir, e.name) + (e.isDirectory() ? path.sep : ""));
  } catch {
    return [];
  }
}

function completer(line: string): [string[], string] {
  const trimmed = line.trim();
  if (trimmed.startsWith("/")) {
    const matches = SLASH_COMMANDS.filter((c) => c.startsWith(trimmed));
    return [matches.length > 0 ? matches : SLASH_COMMANDS, line];
  }
  // path completion: take last whitespace-delimited token
  const m = line.match(/(\S+)$/);
  if (m) {
    const token = m[1];
    if (token.length > 0 && (token.startsWith(".") || token.startsWith("/") || token.startsWith("~") || /^[A-Za-z]:/.test(token) || token.startsWith("@"))) {
      const ref = token.startsWith("@") ? token.slice(1) : token;
      const matches = pathCompleter(ref);
      const prefix = token.startsWith("@") ? "@" : "";
      return [matches.map((m) => prefix + m), token];
    }
  }
  return [[], line];
}

async function loadHistory(): Promise<string[]> {
  if (!historyPath) return [];
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    return raw.split("\n").filter((l) => l.length > 0).slice(-1000);
  } catch {
    return [];
  }
}

async function saveHistoryLine(line: string): Promise<void> {
  if (!historyPath || line.trim().length === 0) return;
  try {
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    await fs.appendFile(historyPath, line + "\n", "utf8");
  } catch {
    // best-effort
  }
}

async function init(): Promise<void> {
  if (sharedRl) return;
  isTty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (isTty) {
    historyPath = path.join(os.homedir(), ".arnie", "history");
    const history = await loadHistory();
    sharedRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer,
      history,
      historySize: 1000,
      removeHistoryDuplicates: true,
    });
  } else {
    sharedRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
  }
  sharedRl.on("line", (line) => {
    if (isTty) void saveHistoryLine(line);
    const w = waiters.shift();
    if (w) w.resolve(line);
    else lineQueue.push(line);
  });
  sharedRl.on("close", () => {
    stdinClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.reject(new Error("stdin closed"));
    }
  });
}

export function closeReadline(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

export async function prompt(message: string): Promise<string> {
  await init();
  if (lineQueue.length > 0) {
    const line = lineQueue.shift()!;
    if (!isTty) {
      process.stdout.write(message);
      process.stdout.write(line + "\n");
    }
    return line;
  }
  if (stdinClosed) throw new Error("stdin closed");
  if (isTty && sharedRl) {
    sharedRl.setPrompt(message);
    sharedRl.prompt(true);
  } else {
    process.stdout.write(message);
  }
  return new Promise<string>((resolve, reject) => {
    waiters.push({ resolve, reject });
  });
}

export async function confirm(message: string): Promise<boolean> {
  try {
    const answer = await prompt(`${chalk.yellow(message)} ${chalk.dim("[y/N] ")}`);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  }
}

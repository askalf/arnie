import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReadFile } from "./tools/readFile.js";
import { runShell } from "./tools/shell.js";
import { runListDir } from "./tools/listDir.js";
import { parseArgs } from "./config.js";
import { accumulate, emptyTotals, turnCost } from "./usage.js";
import { createTranscriptWriter } from "./transcript.js";

interface Case {
  name: string;
  pass: boolean;
  detail?: string;
}

const cases: Case[] = [];

const DESTRUCTIVE_PATTERNS = [
  { pattern: /\brm\b\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|-[a-zA-Z]+\s+)*/, name: "rm with flags" },
  { pattern: /\bRemove-Item\b/i, name: "Remove-Item" },
  { pattern: /\bformat\b\s+[a-zA-Z]:/i, name: "drive format" },
  { pattern: /\breg\s+(?:delete|add)/i, name: "registry edit" },
  { pattern: /\b(?:apt|apt-get|yum|dnf|pacman)\s+(?:remove|purge|autoremove)\b/i, name: "package removal" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, name: "shutdown" },
];

function matches(cmd: string): string | null {
  for (const { pattern, name } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) return name;
  }
  return null;
}

const positive = [
  "rm -rf /tmp/foo",
  "Remove-Item C:\\Users\\foo\\bar -Recurse",
  "format c:",
  "reg delete HKLM\\Software\\Foo",
  "sudo apt remove nginx",
  "shutdown -h now",
];
for (const cmd of positive) {
  const hit = matches(cmd);
  cases.push({
    name: `destructive detected: ${cmd}`,
    pass: hit !== null,
    detail: hit ?? "NO MATCH",
  });
}

const negative = [
  "ls -la",
  "cat /etc/hosts",
  "Get-Process",
  "ipconfig /all",
  "git status",
  "ps aux",
  "df -h",
];
for (const cmd of negative) {
  const hit = matches(cmd);
  cases.push({
    name: `safe NOT flagged: ${cmd}`,
    pass: hit === null,
    detail: hit ? `false positive: ${hit}` : "ok",
  });
}

async function readFileTests(): Promise<void> {
  const r1 = await runReadFile({ path: "package.json" });
  cases.push({
    name: "read_file: read package.json",
    pass: r1.ok && r1.content !== undefined && r1.content.includes('"name": "arnie"'),
    detail: r1.ok ? `${r1.bytes} bytes, name found=${r1.content?.includes('"name": "arnie"')}` : `error: ${r1.error}`,
  });

  const r2 = await runReadFile({ path: "package.json", start_line: 1, end_line: 3 });
  cases.push({
    name: "read_file: line range 1-3",
    pass: r2.ok && r2.content !== undefined && r2.content.split("\n").length === 3,
    detail: r2.ok ? `lines=${r2.content?.split("\n").length}` : `error: ${r2.error}`,
  });

  const r3 = await runReadFile({ path: "this-file-does-not-exist.xyz" });
  cases.push({
    name: "read_file: missing file returns error",
    pass: !r3.ok && r3.error !== undefined,
    detail: r3.error ?? "expected error, got success",
  });

  const r4 = await runReadFile({ path: "src" });
  cases.push({
    name: "read_file: directory returns error",
    pass: !r4.ok && r4.error !== undefined && r4.error.toLowerCase().includes("directory"),
    detail: r4.error ?? "expected directory error",
  });
}

async function shellTests(): Promise<void> {
  const echoCmd = process.platform === "win32" ? 'Write-Output "hello-from-arnie"' : 'echo "hello-from-arnie"';
  const r1 = await runShell({ command: echoCmd, reason: "test echo" });
  cases.push({
    name: "shell: echo captures stdout",
    pass: r1.ok && r1.stdout.includes("hello-from-arnie"),
    detail: r1.ok ? `exit=${r1.exit_code}, stdout="${r1.stdout.trim()}"` : `failed: ${r1.stderr}`,
  });

  const r2 = await runShell({
    command: process.platform === "win32" ? "exit 7" : "exit 7",
    reason: "test non-zero exit",
  });
  cases.push({
    name: "shell: non-zero exit reported",
    pass: !r2.ok && r2.exit_code === 7,
    detail: `ok=${r2.ok}, exit_code=${r2.exit_code}`,
  });

  const r3 = await runShell({
    command: process.platform === "win32" ? "Get-Date -Format yyyy" : "date +%Y",
    reason: "test current year",
  });
  const year = new Date().getFullYear().toString();
  cases.push({
    name: "shell: real command output",
    pass: r3.ok && r3.stdout.includes(year),
    detail: r3.ok ? `output contains ${year}: ${r3.stdout.includes(year)}` : `failed: ${r3.stderr}`,
  });
}

async function listDirTests(): Promise<void> {
  const r1 = await runListDir({ path: "." });
  cases.push({
    name: "list_dir: lists current dir",
    pass: r1.ok && (r1.entries?.some((e) => e.name === "package.json") ?? false),
    detail: r1.ok ? `${r1.total} entries, package.json present=${r1.entries?.some((e) => e.name === "package.json")}` : `error: ${r1.error}`,
  });

  const r2 = await runListDir({ path: "this-dir-does-not-exist-xyz" });
  cases.push({
    name: "list_dir: missing dir returns error",
    pass: !r2.ok && r2.error !== undefined,
    detail: r2.error ?? "expected error",
  });

  const r3 = await runListDir({ path: "package.json" });
  cases.push({
    name: "list_dir: file path returns error",
    pass: !r3.ok && r3.error !== undefined && r3.error.toLowerCase().includes("not a directory"),
    detail: r3.error ?? "expected error",
  });
}

function configTests(): void {
  const c1 = parseArgs([]);
  cases.push({
    name: "config: defaults",
    pass: c1.model === "claude-opus-4-7" && c1.effort === "high" && c1.maxTokens === 16000 && c1.thinking === "adaptive" && c1.transcript,
    detail: `model=${c1.model}, effort=${c1.effort}, max_tokens=${c1.maxTokens}, thinking=${c1.thinking}, transcript=${c1.transcript}`,
  });

  const c2 = parseArgs(["--model", "claude-haiku-4-5", "--effort", "low", "--max-tokens", "1024"]);
  cases.push({
    name: "config: model/effort/max-tokens flags",
    pass: c2.model === "claude-haiku-4-5" && c2.effort === "low" && c2.maxTokens === 1024,
    detail: `${c2.model} ${c2.effort} ${c2.maxTokens}`,
  });

  const c3 = parseArgs(["--no-thinking", "--no-transcript", "--no-usage"]);
  cases.push({
    name: "config: --no-* flags",
    pass: c3.thinking === "disabled" && !c3.transcript && !c3.showUsage,
    detail: `thinking=${c3.thinking}, transcript=${c3.transcript}, showUsage=${c3.showUsage}`,
  });

  let badEffort = false;
  try {
    parseArgs(["--effort", "bogus"]);
  } catch {
    badEffort = true;
  }
  cases.push({ name: "config: invalid effort throws", pass: badEffort, detail: badEffort ? "rejected" : "should have thrown" });

  let unknown = false;
  try {
    parseArgs(["--banana"]);
  } catch {
    unknown = true;
  }
  cases.push({ name: "config: unknown flag throws", pass: unknown, detail: unknown ? "rejected" : "should have thrown" });

  let missingValue = false;
  try {
    parseArgs(["--model"]);
  } catch {
    missingValue = true;
  }
  cases.push({ name: "config: missing flag value throws", pass: missingValue, detail: missingValue ? "rejected" : "should have thrown" });
}

function usageTests(): void {
  const totals = emptyTotals();
  accumulate(totals, "claude-opus-4-7", {
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: null,
  });
  // 1000 * 5/1M + 500 * 25/1M = 0.005 + 0.0125 = 0.0175
  const expected = 0.0175;
  cases.push({
    name: "usage: cost calculation for opus 4.7",
    pass: Math.abs(totals.costUsd - expected) < 1e-6 && totals.turns === 1,
    detail: `cost=${totals.costUsd}, expected=${expected}, turns=${totals.turns}`,
  });

  const single = turnCost("claude-haiku-4-5", {
    input_tokens: 1000,
    output_tokens: 1000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: null,
  });
  // haiku: 1000*1/1M + 1000*5/1M = 0.001 + 0.005 = 0.006
  cases.push({
    name: "usage: cost calculation for haiku 4.5",
    pass: Math.abs(single - 0.006) < 1e-6,
    detail: `cost=${single}, expected=0.006`,
  });

  const unknownCost = turnCost("claude-fake-model", {
    input_tokens: 1000,
    output_tokens: 1000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: null,
  });
  cases.push({
    name: "usage: unknown model returns 0",
    pass: unknownCost === 0,
    detail: `cost=${unknownCost}`,
  });
}

async function transcriptTests(): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `arnie-test-${Date.now()}`);
  const t = createTranscriptWriter({ enabled: true, dir: tmpDir });
  await t.startSession({ model: "test", cwd: process.cwd(), hostname: "test", user: "test" });
  await t.appendUser("hello");
  await t.endSession();

  const tPath = t.path!;
  const content = await fs.readFile(tPath, "utf8");
  const lines = content.trim().split("\n");
  const firstRecord = JSON.parse(lines[0]);

  cases.push({
    name: "transcript: writes JSONL records",
    pass: lines.length === 3 && firstRecord.kind === "session_start" && firstRecord.model === "test",
    detail: `${lines.length} lines, first.kind=${firstRecord.kind}`,
  });

  const disabled = createTranscriptWriter({ enabled: false });
  cases.push({
    name: "transcript: disabled writer is noop",
    pass: !disabled.enabled && disabled.path === null,
    detail: `enabled=${disabled.enabled}, path=${disabled.path}`,
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await readFileTests();
  await shellTests();
  await listDirTests();
  configTests();
  usageTests();
  await transcriptTests();

  console.log();
  console.log("=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));

  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const tag = c.pass ? "PASS" : "FAIL";
    const line = `[${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
    console.log(line);
    if (c.pass) passed++;
    else failed++;
  }

  console.log();
  console.log(`${passed} passed, ${failed} failed (${cases.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

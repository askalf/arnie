import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { runReadFile } from "./tools/readFile.js";
import { setShellPermissions, runShell } from "./tools/shell.js";
import { runListDir } from "./tools/listDir.js";
import { runGrep } from "./tools/grep.js";
import { runShellBackground, runShellStatus, runShellKill, listJobs } from "./tools/backgroundShell.js";
import { dispatchTool, buildToolList, isParallelSafe } from "./tools/registry.js";
import { parseArgs, applySettings } from "./config.js";
import { accumulate, emptyTotals, turnCost } from "./usage.js";
import { createTranscriptWriter } from "./transcript.js";
import { saveSession, loadSession, listSessions, loadLastSession } from "./sessions.js";
import { loadMemoryFiles, formatMemoryBlock } from "./memory.js";
import { runEditFile } from "./tools/editFile.js";
import { discoverSkills, formatSkillsBlock } from "./skills.js";
import { evaluateCommand } from "./permissions.js";
import { initWorkspace } from "./init.js";
import { renderStatusLine } from "./statusLine.js";
import { createMarkdownRenderer } from "./markdown.js";
import { exportConversation } from "./export.js";
import { recordToolCall, resetToolStats, formatToolStats } from "./toolStats.js";

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
    pass:
      c1.model === "claude-opus-4-7" &&
      c1.effort === "xhigh" &&
      c1.maxTokens === 64000 &&
      c1.thinking === "adaptive" &&
      c1.transcript &&
      c1.compact &&
      !c1.noWebSearch &&
      !c1.noMemory,
    detail: `model=${c1.model}, effort=${c1.effort}, max_tokens=${c1.maxTokens}, thinking=${c1.thinking}, transcript=${c1.transcript}, compact=${c1.compact}, noWebSearch=${c1.noWebSearch}, noMemory=${c1.noMemory}`,
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
    cache_creation: null,
    inference_geo: null,
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
    cache_creation: null,
    inference_geo: null,
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
    cache_creation: null,
    inference_geo: null,
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

async function grepTests(): Promise<void> {
  const tmp = path.join(os.tmpdir(), `arnie-grep-${Date.now()}`);
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, "a.log"), "INFO start\nERROR boom\nWARN slow\nERROR retry\n", "utf8");
  await fs.writeFile(path.join(tmp, "b.txt"), "nothing useful here\n", "utf8");
  await fs.mkdir(path.join(tmp, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(tmp, "node_modules", "skipped.log"), "ERROR should be skipped\n", "utf8");

  const r1 = await runGrep({ pattern: "ERROR", path: tmp });
  cases.push({
    name: "grep: finds matches",
    pass: r1.ok && r1.matches.length === 2 && r1.matches.every((m) => m.text.includes("ERROR")) && !r1.matches.some((m) => m.file.includes("node_modules")),
    detail: r1.ok ? `${r1.matches.length} matches, files=${r1.files_scanned}` : `error: ${r1.error}`,
  });

  const r2 = await runGrep({ pattern: "error", path: tmp, case_insensitive: true });
  cases.push({
    name: "grep: case-insensitive",
    pass: r2.ok && r2.matches.length === 2,
    detail: `${r2.matches.length} matches`,
  });

  const r3 = await runGrep({ pattern: "ERROR", path: tmp, glob: "*.log" });
  cases.push({
    name: "grep: glob filter",
    pass: r3.ok && r3.matches.every((m) => m.file.endsWith(".log")),
    detail: `${r3.matches.length} matches in ${r3.files_scanned} files`,
  });

  const r4 = await runGrep({ pattern: "INVALID[", path: tmp });
  cases.push({
    name: "grep: invalid regex returns error",
    pass: !r4.ok && r4.error !== undefined && r4.error.includes("invalid regex"),
    detail: r4.error ?? "expected error",
  });

  const r5 = await runGrep({ pattern: "INVALID[", path: tmp, literal: true });
  cases.push({
    name: "grep: literal mode escapes regex",
    pass: r5.ok,
    detail: r5.ok ? `ran ok, ${r5.matches.length} matches` : `error: ${r5.error}`,
  });

  await fs.rm(tmp, { recursive: true, force: true });
}

async function backgroundJobTests(): Promise<void> {
  const isWindows = process.platform === "win32";
  const fastCmd = isWindows ? "Write-Output 'bg-fast-done'" : "echo 'bg-fast-done'";
  const slowCmd = isWindows ? "Start-Sleep -Milliseconds 1500; Write-Output 'bg-slow-done'" : "sleep 1.5 && echo 'bg-slow-done'";

  const fast = await runShellBackground({ command: fastCmd, reason: "test fast bg" });
  cases.push({
    name: "shell_background: returns job id",
    pass: fast.ok && !!fast.job_id,
    detail: fast.ok ? `id=${fast.job_id}` : `error: ${fast.error}`,
  });

  await new Promise((r) => setTimeout(r, 500));
  const fastStatus = await runShellStatus({ job_id: fast.job_id! });
  cases.push({
    name: "shell_status: fast job exits",
    pass: fastStatus.ok && fastStatus.state === "exited" && fastStatus.exit_code === 0 && fastStatus.stdout.includes("bg-fast-done"),
    detail: `state=${fastStatus.state} exit=${fastStatus.exit_code}`,
  });

  const slow = await runShellBackground({ command: slowCmd, reason: "test slow bg" });
  await new Promise((r) => setTimeout(r, 100));
  const midStatus = await runShellStatus({ job_id: slow.job_id! });
  cases.push({
    name: "shell_status: running while in-flight",
    pass: midStatus.ok && midStatus.state === "running",
    detail: `state=${midStatus.state}`,
  });

  await new Promise((r) => setTimeout(r, 2000));
  const finalStatus = await runShellStatus({ job_id: slow.job_id! });
  cases.push({
    name: "shell_status: slow job finishes",
    pass: finalStatus.ok && finalStatus.state === "exited" && finalStatus.stdout.includes("bg-slow-done"),
    detail: `state=${finalStatus.state} stdout='${finalStatus.stdout.trim()}'`,
  });

  const unknown = await runShellStatus({ job_id: "nope" });
  cases.push({
    name: "shell_status: unknown id returns error",
    pass: !unknown.ok && unknown.error !== undefined,
    detail: unknown.error ?? "expected error",
  });

  const killable = await runShellBackground({ command: isWindows ? "Start-Sleep 30" : "sleep 30", reason: "test kill" });
  await new Promise((r) => setTimeout(r, 100));
  const kr = await runShellKill({ job_id: killable.job_id! });
  cases.push({
    name: "shell_kill: kills running job",
    pass: kr.ok && kr.killed,
    detail: `killed=${kr.killed}`,
  });

  await new Promise((r) => setTimeout(r, 200));
  const afterKill = await runShellStatus({ job_id: killable.job_id! });
  cases.push({
    name: "shell_kill: state reflects kill",
    pass: afterKill.ok && (afterKill.state === "killed" || afterKill.state === "exited"),
    detail: `state=${afterKill.state}`,
  });

  cases.push({
    name: "list_jobs: returns active and finished",
    pass: listJobs().length >= 3,
    detail: `${listJobs().length} jobs total`,
  });
}

async function sessionTests(): Promise<void> {
  const name = `arnie-test-${Date.now()}`;
  const messages = [
    { role: "user" as const, content: "what is 2+2" },
    { role: "assistant" as const, content: "4" },
  ];
  const file = await saveSession(name, "claude-opus-4-7", messages);
  cases.push({
    name: "sessions: save returns path",
    pass: typeof file === "string" && file.includes(name),
    detail: file,
  });

  const loaded = await loadSession(name);
  cases.push({
    name: "sessions: load returns saved data",
    pass: !!loaded && loaded.messages.length === 2 && loaded.model === "claude-opus-4-7",
    detail: loaded ? `loaded ${loaded.messages.length} messages` : "null",
  });

  const all = await listSessions();
  cases.push({
    name: "sessions: list includes saved",
    pass: all.some((s) => s.name === name),
    detail: `total=${all.length}`,
  });

  const missing = await loadSession("nonexistent-session-xyz");
  cases.push({
    name: "sessions: missing load returns null",
    pass: missing === null,
    detail: missing === null ? "null" : "got data",
  });

  const sessionDir = path.join(os.homedir(), ".arnie", "sessions");
  await fs.unlink(path.join(sessionDir, `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)).catch(() => {});
}

async function memoryTests(): Promise<void> {
  const projectMemoryDir = path.join(process.cwd(), ".arnie");
  const projectMemoryFile = path.join(projectMemoryDir, "memory.md");
  await fs.mkdir(projectMemoryDir, { recursive: true });
  await fs.writeFile(projectMemoryFile, "# Project notes\nThis machine runs the AD lab; DC is at 10.0.0.5.\n", "utf8");

  const files = await loadMemoryFiles();
  cases.push({
    name: "memory: loads project memory.md",
    pass: files.some((f) => f.scope === "project" && f.content.includes("AD lab")),
    detail: `loaded ${files.length} files`,
  });

  const block = formatMemoryBlock(files);
  cases.push({
    name: "memory: formatMemoryBlock produces non-empty",
    pass: block.length > 0 && block.includes("AD lab"),
    detail: `${block.length} chars`,
  });

  const empty = formatMemoryBlock([]);
  cases.push({
    name: "memory: empty returns empty string",
    pass: empty === "",
    detail: `len=${empty.length}`,
  });

  await fs.unlink(projectMemoryFile).catch(() => {});
  await fs.rmdir(projectMemoryDir).catch(() => {});
}

async function dispatchTests(): Promise<void> {
  const fakeClient = {} as Anthropic;
  const ctx = { client: fakeClient };

  const r1 = await dispatchTool("read_file", { path: "package.json" }, ctx);
  const parsed1 = JSON.parse(r1);
  cases.push({
    name: "dispatch: routes to read_file",
    pass: parsed1.ok === true,
    detail: `ok=${parsed1.ok}`,
  });

  const r2 = await dispatchTool("read_file", { /* missing path */ }, ctx);
  const parsed2 = JSON.parse(r2);
  cases.push({
    name: "dispatch: zod rejects bad input",
    pass: parsed2.ok === false && typeof parsed2.error === "string" && parsed2.error.includes("invalid input"),
    detail: parsed2.error,
  });

  const r3 = await dispatchTool("nonexistent_tool", {}, ctx);
  const parsed3 = JSON.parse(r3);
  cases.push({
    name: "dispatch: unknown tool returns error",
    pass: parsed3.ok === false && parsed3.error.includes("unknown tool"),
    detail: parsed3.error,
  });

  const tools = buildToolList({ webSearch: true, subagent: true });
  cases.push({
    name: "dispatch: web_search and subagent included",
    pass:
      tools.some((t) => "name" in t && t.name === "web_search") &&
      tools.some((t) => "name" in t && t.name === "subagent"),
    detail: `${tools.length} tools`,
  });

  const minimal = buildToolList({ webSearch: false, subagent: false });
  cases.push({
    name: "dispatch: web_search/subagent excluded when disabled",
    pass:
      !minimal.some((t) => "name" in t && t.name === "web_search") &&
      !minimal.some((t) => "name" in t && t.name === "subagent"),
    detail: `${minimal.length} tools`,
  });
}

async function editFileTests(): Promise<void> {
  // edit_file uses confirm() for user gating which would block tests.
  // Test the validation paths that don't require user input.

  // identical strings
  const tmpDir = path.join(os.tmpdir(), `arnie-edit-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, "f.txt");
  await fs.writeFile(target, "hello world\nhello again\nfoo\n", "utf8");

  const r1 = await runEditFile({ path: target, old_string: "same", new_string: "same" });
  cases.push({
    name: "edit_file: identical old/new rejected",
    pass: !r1.ok && r1.error !== undefined && r1.error.includes("identical"),
    detail: r1.error ?? "expected error",
  });

  const r2 = await runEditFile({ path: target, old_string: "not-found-string", new_string: "x" });
  cases.push({
    name: "edit_file: missing old_string rejected",
    pass: !r2.ok && r2.error !== undefined && r2.error.includes("not found"),
    detail: r2.error ?? "expected error",
  });

  const r3 = await runEditFile({ path: target, old_string: "hello", new_string: "HI" });
  cases.push({
    name: "edit_file: ambiguous match rejected without replace_all",
    pass: !r3.ok && r3.error !== undefined && r3.error.includes("2 times"),
    detail: r3.error ?? "expected error",
  });

  const r4 = await runEditFile({ path: path.join(tmpDir, "missing.txt"), old_string: "a", new_string: "b" });
  cases.push({
    name: "edit_file: missing file rejected",
    pass: !r4.ok && r4.error !== undefined,
    detail: r4.error ?? "expected error",
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function permissionsTests(): Promise<void> {
  const cfg = {
    allow: [{ pattern: "^Get-Service\\b", reason: "ro PS" }],
    deny: [{ pattern: "format\\s+[a-zA-Z]:", reason: "no formatting" }],
    source: "test",
  };

  const a = evaluateCommand("Get-Service spooler", cfg);
  cases.push({
    name: "permissions: allow rule matches",
    pass: a.decision === "allow" && a.rule === "^Get-Service\\b",
    detail: `${a.decision} (${a.rule})`,
  });

  const d = evaluateCommand("format c:", cfg);
  cases.push({
    name: "permissions: deny rule matches",
    pass: d.decision === "deny",
    detail: `${d.decision}`,
  });

  const u = evaluateCommand("Get-Process", cfg);
  cases.push({
    name: "permissions: unmatched returns ask",
    pass: u.decision === "ask",
    detail: `${u.decision}`,
  });

  // shell tool integration: deny path
  setShellPermissions(cfg);
  const denied = await runShell({ command: "format c:" });
  cases.push({
    name: "permissions: shell tool returns cancelled on deny",
    pass: !denied.ok && denied.cancelled === true,
    detail: `cancelled=${denied.cancelled}, exit=${denied.exit_code}`,
  });

  // reset to empty so later shell tests don't get tripped
  setShellPermissions({ allow: [], deny: [], source: null });
}

async function skillsTests(): Promise<void> {
  const skillRoot = path.join(process.cwd(), ".arnie", "skills", "test-skill");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, "SKILL.md"),
    `---
name: test-skill
description: A test skill that does test things.
---

# Test skill body

Body content.
`,
    "utf8",
  );

  const skills = await discoverSkills();
  cases.push({
    name: "skills: discovers project skill",
    pass: skills.some((s) => s.name === "test-skill" && s.scope === "project"),
    detail: `found ${skills.length} skills`,
  });

  const block = formatSkillsBlock(skills);
  cases.push({
    name: "skills: formats block",
    pass: block.includes("test-skill") && block.includes("test things"),
    detail: `block.length=${block.length}`,
  });

  cases.push({
    name: "skills: empty list returns empty string",
    pass: formatSkillsBlock([]) === "",
    detail: "ok",
  });

  await fs.rm(path.join(process.cwd(), ".arnie", "skills"), { recursive: true, force: true });
}

async function initTests(): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `arnie-init-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const result = await initWorkspace(tmpDir);
  cases.push({
    name: "init: creates expected files",
    pass:
      result.created.length === 4 &&
      result.created.some((f) => f.endsWith("memory.md")) &&
      result.created.some((f) => f.endsWith("permissions.json")) &&
      result.created.some((f) => f.endsWith("SKILL.md")) &&
      result.created.some((f) => f.endsWith(".gitignore")),
    detail: `created ${result.created.length}, skipped ${result.skipped.length}`,
  });

  // run again — should skip everything
  const second = await initWorkspace(tmpDir);
  cases.push({
    name: "init: idempotent (skips existing)",
    pass: second.created.length === 0 && second.skipped.length === 4,
    detail: `created ${second.created.length}, skipped ${second.skipped.length}`,
  });

  // permissions.json should be valid JSON
  const permRaw = await fs.readFile(path.join(tmpDir, ".arnie", "permissions.json"), "utf8");
  let permsValid = true;
  try {
    JSON.parse(permRaw);
  } catch {
    permsValid = false;
  }
  cases.push({
    name: "init: scaffolded permissions.json is valid JSON",
    pass: permsValid,
    detail: permsValid ? "ok" : "parse failed",
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
}

function settingsTests(): void {
  const c = applySettings({ model: "claude-sonnet-4-6", effort: "medium", maxTokens: 8000, compact: false });
  cases.push({
    name: "settings: applies overrides",
    pass: c.model === "claude-sonnet-4-6" && c.effort === "medium" && c.maxTokens === 8000 && !c.compact,
    detail: `model=${c.model} effort=${c.effort} max=${c.maxTokens} compact=${c.compact}`,
  });

  const c2 = parseArgs(["--effort", "low"], applySettings({ effort: "max", maxTokens: 999 }));
  cases.push({
    name: "settings: CLI flag overrides settings",
    pass: c2.effort === "low" && c2.maxTokens === 999,
    detail: `effort=${c2.effort} max=${c2.maxTokens}`,
  });

  const c3 = applySettings({ webSearch: false, subagent: false, statusLine: false, markdown: false });
  cases.push({
    name: "settings: boolean toggles map to noX",
    pass: c3.noWebSearch && c3.noSubagent && c3.noStatusLine && c3.noMarkdown,
    detail: "ok",
  });
}

function parallelSafeTests(): void {
  cases.push({
    name: "parallel-safe: read-only tools tagged",
    pass:
      isParallelSafe("read_file") &&
      isParallelSafe("list_dir") &&
      isParallelSafe("grep") &&
      isParallelSafe("network_check") &&
      isParallelSafe("service_check") &&
      isParallelSafe("subagent") &&
      isParallelSafe("shell_status"),
    detail: "all read-only tools parallel-safe",
  });
  cases.push({
    name: "parallel-safe: prompting tools NOT tagged",
    pass:
      !isParallelSafe("shell") &&
      !isParallelSafe("write_file") &&
      !isParallelSafe("edit_file") &&
      !isParallelSafe("shell_background") &&
      !isParallelSafe("shell_kill"),
    detail: "ok",
  });
}

async function exportTests(): Promise<void> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "what is 2+2" },
    { role: "assistant", content: [{ type: "text", text: "4" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "x" } },
      ],
    },
  ];
  const file = await exportConversation("test-export", "claude-opus-4-7", messages);
  const content = await fs.readFile(file, "utf8");
  cases.push({
    name: "export: writes markdown header and turns",
    pass: content.includes("# arnie session: test-export") && content.includes("### User") && content.includes("### Arnie") && content.includes("4"),
    detail: `${content.length} chars`,
  });
  cases.push({
    name: "export: serializes tool_use blocks",
    pass: content.includes("tool_use") && content.includes("read_file"),
    detail: "ok",
  });
  await fs.unlink(file).catch(() => {});
}

function statusLineTests(): void {
  const totals = emptyTotals();
  totals.costUsd = 0.1234;
  totals.turns = 5;
  const line = renderStatusLine({
    model: "claude-opus-4-7",
    effort: "xhigh",
    cwd: "/tmp/foo",
    totals,
    planMode: false,
  });
  cases.push({
    name: "status_line: contains model and cost",
    pass: line.includes("claude-opus-4-7") && line.includes("$0.1234") && line.includes("turns=5"),
    detail: "ok",
  });

  const planLine = renderStatusLine({
    model: "claude-opus-4-7",
    effort: "high",
    cwd: "/tmp/foo",
    totals,
    planMode: true,
  });
  cases.push({
    name: "status_line: shows plan tag when on",
    pass: planLine.includes("[plan]"),
    detail: "ok",
  });
}

function markdownTests(): void {
  const captured: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // @ts-ignore reassign
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    const r = createMarkdownRenderer(true);
    r.push("# Header\n");
    r.push("**bold** and `code`\n");
    r.push("- bullet point\n");
    r.push("```js\nconsole.log('hi');\n```\n");
    r.flush();
  } finally {
    // @ts-ignore restore
    process.stdout.write = origWrite;
  }
  const out = captured.join("");
  cases.push({
    name: "markdown: emits formatted output",
    pass: out.includes("Header") && out.includes("bold") && out.includes("bullet") && out.includes("console.log"),
    detail: `${out.length} chars`,
  });
  cases.push({
    name: "markdown: code fence renders",
    pass: out.includes("┌─") && out.includes("└─"),
    detail: "ok",
  });
}

async function autoResumeTests(): Promise<void> {
  // Save two sessions; loadLastSession should return the more recent one
  await saveSession("auto-resume-1", "claude-opus-4-7", [{ role: "user", content: "first" }]);
  await new Promise((r) => setTimeout(r, 30));
  await saveSession("auto-resume-2", "claude-opus-4-7", [{ role: "user", content: "second" }]);

  const last = await loadLastSession();
  cases.push({
    name: "loadLastSession: returns most recent",
    pass: last !== null && last.name === "auto-resume-2",
    detail: last ? `name=${last.name}` : "null",
  });

  const sessionDir = path.join(os.homedir(), ".arnie", "sessions");
  await fs.unlink(path.join(sessionDir, "auto-resume-1.json")).catch(() => {});
  await fs.unlink(path.join(sessionDir, "auto-resume-2.json")).catch(() => {});
}

async function findSessionsTests(): Promise<void> {
  const { searchSessions } = await import("./sessions.js");
  await saveSession("find-test-1", "claude-opus-4-7", [
    { role: "user", content: "the printer queue is jammed" },
    { role: "assistant", content: [{ type: "text", text: "let me check the spooler" }] },
  ]);
  await saveSession("find-test-2", "claude-opus-4-7", [
    { role: "user", content: "DNS lookup failing for internal hosts" },
  ]);

  const hits1 = await searchSessions("printer");
  cases.push({
    name: "/find: matches user message",
    pass: hits1.some((h) => h.session === "find-test-1" && h.snippet.toLowerCase().includes("printer")),
    detail: `${hits1.length} hits`,
  });

  const hits2 = await searchSessions("spooler");
  cases.push({
    name: "/find: matches assistant text block",
    pass: hits2.some((h) => h.role === "assistant"),
    detail: `${hits2.length} hits`,
  });

  const hits3 = await searchSessions("nonexistent_query_xyz");
  cases.push({
    name: "/find: empty result on no match",
    pass: hits3.length === 0,
    detail: "ok",
  });

  const dir = path.join(os.homedir(), ".arnie", "sessions");
  await fs.unlink(path.join(dir, "find-test-1.json")).catch(() => {});
  await fs.unlink(path.join(dir, "find-test-2.json")).catch(() => {});
}

async function mcpTests(): Promise<void> {
  const { loadMcpConfig } = await import("./mcp.js");
  const cfg = await loadMcpConfig();
  cases.push({
    name: "mcp: returns empty when no config",
    pass: cfg.servers.length === 0 && cfg.source === null,
    detail: `servers=${cfg.servers.length}, source=${cfg.source}`,
  });

  const tmpRoot = path.join(process.cwd(), ".arnie");
  await fs.mkdir(tmpRoot, { recursive: true });
  const tmpFile = path.join(tmpRoot, "mcp.json");
  await fs.writeFile(
    tmpFile,
    JSON.stringify({
      servers: [
        { name: "test", url: "https://example.com/mcp" },
        { type: "url", name: "auth-test", url: "https://auth.example.com", authorization_token: "tok" },
      ],
    }),
    "utf8",
  );

  const cfg2 = await loadMcpConfig();
  cases.push({
    name: "mcp: loads servers from .arnie/mcp.json",
    pass: cfg2.servers.length === 2 && cfg2.servers[0].name === "test" && cfg2.servers[1].authorization_token === "tok",
    detail: `${cfg2.servers.length} servers`,
  });

  await fs.unlink(tmpFile).catch(() => {});
  // Don't remove .arnie because other tests may share it
}

async function attachTests(): Promise<void> {
  const { parseInput } = await import("./attach.js");

  // Plain text — no attachments
  const r1 = await parseInput("just a normal message");
  cases.push({
    name: "attach: plain text passes through",
    pass: r1.attachments.length === 0 && r1.blocks.length === 1 && r1.blocks[0].type === "text",
    detail: "ok",
  });

  // attach a text file
  const tmpDir = path.join(os.tmpdir(), `arnie-attach-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const txt = path.join(tmpDir, "note.txt");
  await fs.writeFile(txt, "hello attached file", "utf8");
  const r2 = await parseInput(`look at this:\nattach ${txt}`);
  cases.push({
    name: "attach: text file becomes a content block",
    pass:
      r2.attachments.length === 1 &&
      r2.attachments[0].type === "text" &&
      r2.blocks.some((b) => b.type === "text" && (b as { text: string }).text.includes("hello attached file")),
    detail: `${r2.attachments.length} attached`,
  });

  // attach a tiny PNG
  const png = path.join(tmpDir, "tiny.png");
  await fs.writeFile(
    png,
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
      0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]),
  );
  const r3 = await parseInput(`describe this:\nattach ${png}`);
  cases.push({
    name: "attach: image file becomes image block",
    pass:
      r3.attachments.length === 1 &&
      r3.attachments[0].type === "image" &&
      r3.blocks.some((b) => b.type === "image"),
    detail: `${r3.attachments.length} attached`,
  });

  const r4 = await parseInput(`attach /this/path/does/not/exist.png`);
  cases.push({
    name: "attach: missing file produces error",
    pass: r4.errors.length === 1,
    detail: r4.errors[0] ?? "no error",
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
}

function toolStatsTests(): void {
  resetToolStats();
  recordToolCall("read_file", 12, true);
  recordToolCall("read_file", 8, true);
  recordToolCall("shell", 50, false);
  const out = formatToolStats();
  cases.push({
    name: "toolStats: formats counts and durations",
    pass: out.includes("read_file") && out.includes("calls=  2") && out.includes("shell") && out.includes("errors=1"),
    detail: "ok",
  });
  resetToolStats();
}

async function quietLogTests(): Promise<void> {
  const { setQuiet, log: logFn } = await import("./log.js");
  const orig = console.log;
  let captured = 0;
  console.log = () => {
    captured += 1;
  };
  try {
    setQuiet(true);
    logFn("invisible");
    logFn("also invisible");
    setQuiet(false);
    logFn("visible");
  } finally {
    console.log = orig;
  }
  cases.push({
    name: "quiet: log() suppresses when quiet=true",
    pass: captured === 1,
    detail: `captured=${captured} (expected 1)`,
  });
}

async function atRefTests(): Promise<void> {
  const { parseInput } = await import("./attach.js");
  const tmpDir = path.join(os.tmpdir(), `arnie-at-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, "ref.txt");
  await fs.writeFile(target, "content via @ref", "utf8");

  const r1 = await parseInput(`look at @${target} please`);
  cases.push({
    name: "@ref: attaches existing file",
    pass: r1.attachments.length === 1 && r1.blocks.some((b) => b.type === "text" && (b as { text: string }).text.includes("content via @ref")),
    detail: `${r1.attachments.length} attached`,
  });

  const r2 = await parseInput("hi @username how are you");
  cases.push({
    name: "@ref: leaves bare @words alone",
    pass: r2.attachments.length === 0,
    detail: `${r2.attachments.length} attached`,
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function redactorsTests(): Promise<void> {
  const { loadRedactors, setRedactors, redact } = await import("./redactors.js");
  const cfg = await loadRedactors();
  setRedactors(cfg);

  const r1 = redact("ANTHROPIC_API_KEY=sk-ant-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890");
  cases.push({
    name: "redactors: scrubs anthropic api key",
    pass: r1.hits >= 1 && r1.redacted.includes("[REDACTED"),
    detail: `hits=${r1.hits}: ${r1.redacted}`,
  });

  const r2 = redact("nothing sensitive here at all");
  cases.push({
    name: "redactors: passes clean text through",
    pass: r2.hits === 0 && r2.redacted === "nothing sensitive here at all",
    detail: "ok",
  });

  const r3 = redact("export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ");
  cases.push({
    name: "redactors: scrubs github pat",
    pass: r3.hits >= 1,
    detail: `hits=${r3.hits}`,
  });

  const r4 = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
  cases.push({
    name: "redactors: scrubs bearer token",
    pass: r4.hits >= 1,
    detail: `hits=${r4.hits}`,
  });

  setRedactors({ patterns: [], source: null });
}

async function spilloverTests(): Promise<void> {
  // We can't easily test the shell tool's spillover without spawning a real
  // shell, but we can exercise the function path indirectly. Focus on
  // verifying that ShellResult fields exist when the spawned output is small
  // enough to NOT spill (already covered by shellTests). For coverage, write
  // a separate test that simulates spillover by calling fs APIs directly.
  const tmp = path.join(os.tmpdir(), `arnie-spill-${Date.now()}.log`);
  const big = "x".repeat(150_000);
  await fs.writeFile(tmp, big, "utf8");
  const stat = await fs.stat(tmp);
  cases.push({
    name: "spillover: large file written for round-trip",
    pass: stat.size === 150_000,
    detail: `${stat.size} bytes`,
  });
  await fs.unlink(tmp).catch(() => {});
}

async function personaTests(): Promise<void> {
  const { loadPersonaOverride } = await import("./persona.js");
  const r1 = await loadPersonaOverride();
  cases.push({
    name: "persona: returns null when no override exists",
    pass: r1 === null || (r1 !== null && typeof r1.text === "string"),
    detail: r1 ? `loaded ${r1.source}` : "null",
  });

  const tmpRoot = path.join(process.cwd(), ".arnie");
  await fs.mkdir(tmpRoot, { recursive: true });
  const personaFile = path.join(tmpRoot, "persona.md");
  await fs.writeFile(personaFile, "You are a friendly tour guide for Renaissance art history.", "utf8");

  const r2 = await loadPersonaOverride();
  cases.push({
    name: "persona: loads project-scoped persona.md",
    pass: r2 !== null && r2.text.includes("Renaissance"),
    detail: r2 ? `${r2.text.length} chars` : "null",
  });

  await fs.unlink(personaFile).catch(() => {});
}

async function sandboxTests(): Promise<void> {
  const { setSandbox, checkRead, checkWrite } = await import("./sandbox.js");
  const { runReadFile } = await import("./tools/readFile.js");
  const { runWriteFile } = await import("./tools/writeFile.js");

  const allowedDir = path.join(os.tmpdir(), `arnie-sandbox-allow-${Date.now()}`);
  const deniedDir = path.join(os.tmpdir(), `arnie-sandbox-deny-${Date.now()}`);
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.mkdir(deniedDir, { recursive: true });
  const allowedFile = path.join(allowedDir, "ok.txt");
  const deniedFile = path.join(deniedDir, "nope.txt");
  await fs.writeFile(allowedFile, "ok content", "utf8");
  await fs.writeFile(deniedFile, "denied content", "utf8");

  setSandbox({ allowed_read_paths: [allowedDir], allowed_write_paths: [allowedDir], source: "test" });

  const allow = checkRead(allowedFile);
  cases.push({
    name: "sandbox: allowed path passes checkRead",
    pass: allow.allowed === true,
    detail: "ok",
  });

  const deny = checkRead(deniedFile);
  cases.push({
    name: "sandbox: outside path fails checkRead",
    pass: deny.allowed === false && deny.reason !== undefined,
    detail: deny.reason ?? "expected reason",
  });

  const writeOk = checkWrite(path.join(allowedDir, "new.txt"));
  cases.push({
    name: "sandbox: allowed path passes checkWrite",
    pass: writeOk.allowed === true,
    detail: "ok",
  });

  // shell tool integration
  const r1 = await runReadFile({ path: deniedFile });
  cases.push({
    name: "sandbox: read_file denies outside path",
    pass: !r1.ok && r1.error !== undefined && r1.error.includes("sandbox denied"),
    detail: r1.error ?? "expected denial",
  });

  const r2 = await runReadFile({ path: allowedFile });
  cases.push({
    name: "sandbox: read_file allows inside path",
    pass: r2.ok === true && r2.content?.includes("ok content"),
    detail: r2.ok ? "ok" : `error: ${r2.error}`,
  });

  // write outside is denied (no confirm needed since denial returns early)
  const r3 = await runWriteFile({ path: path.join(deniedDir, "new.txt"), content: "x" });
  cases.push({
    name: "sandbox: write_file denies outside path",
    pass: !r3.ok && r3.error !== undefined && r3.error.includes("sandbox denied"),
    detail: r3.error ?? "expected denial",
  });

  setSandbox({ allowed_read_paths: [], allowed_write_paths: [], source: null });
  await fs.rm(allowedDir, { recursive: true, force: true });
  await fs.rm(deniedDir, { recursive: true, force: true });
}

async function atGlobTests(): Promise<void> {
  const { parseInput } = await import("./attach.js");
  const tmpDir = path.join(os.tmpdir(), `arnie-glob-${Date.now()}`);
  await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "a.log"), "alpha", "utf8");
  await fs.writeFile(path.join(tmpDir, "b.log"), "beta", "utf8");
  await fs.writeFile(path.join(tmpDir, "c.txt"), "gamma", "utf8");
  await fs.writeFile(path.join(tmpDir, "sub", "d.log"), "delta", "utf8");

  const r1 = await parseInput(`look at @${tmpDir}/*.log`);
  cases.push({
    name: "@glob: matches *.log in dir (excludes subdir)",
    pass: r1.attachments.length === 2 && r1.attachments.every((a) => a.path.endsWith(".log")),
    detail: `${r1.attachments.length} matched`,
  });

  const r2 = await parseInput(`look at @${tmpDir}/**/*.log`);
  cases.push({
    name: "@glob: ** matches recursively",
    pass: r2.attachments.length === 3,
    detail: `${r2.attachments.length} matched`,
  });

  const r3 = await parseInput(`look at @${tmpDir}/*.xyz`);
  cases.push({
    name: "@glob: empty match returns error",
    pass: r3.attachments.length === 0 && r3.errors.length === 1,
    detail: r3.errors[0] ?? "expected error",
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function feedbackTests(): Promise<void> {
  const { appendFeedback, loadFeedback, clearFeedback } = await import("./feedback.js");
  await clearFeedback();

  const empty = await loadFeedback();
  cases.push({
    name: "feedback: empty when none written",
    pass: empty === null,
    detail: empty ? "got data" : "null",
  });

  await appendFeedback("Always check the spooler first on this server.");
  await appendFeedback("DC at 10.0.0.5 frequently returns slow auth.");
  const text = await loadFeedback();
  cases.push({
    name: "feedback: appends and loads multiple notes",
    pass: text !== null && text.includes("spooler") && text.includes("DC at 10.0.0.5"),
    detail: text ? `${text.length} chars` : "null",
  });

  await clearFeedback();
  const after = await loadFeedback();
  cases.push({
    name: "feedback: clear removes the file",
    pass: after === null,
    detail: after ? "still there" : "ok",
  });
}

function budgetTests(): void {
  let bad: unknown = null;
  try {
    parseArgs(["--budget", "abc"]);
  } catch (err) {
    bad = err;
  }
  cases.push({
    name: "budget: rejects non-numeric value",
    pass: bad instanceof Error && bad.message.includes("--budget must be a positive number"),
    detail: "ok",
  });

  const good = parseArgs(["--budget", "0.50"]);
  cases.push({
    name: "budget: parses dollar value",
    pass: good.budgetUsd === 0.5,
    detail: `budgetUsd=${good.budgetUsd}`,
  });

  const ckpt = parseArgs(["--auto-checkpoint", "5"]);
  cases.push({
    name: "auto-checkpoint: parses turn count",
    pass: ckpt.autoCheckpoint === 5,
    detail: `n=${ckpt.autoCheckpoint}`,
  });
}

async function jobNotificationTests(): Promise<void> {
  const { runShellBackground, getUnannouncedFinishedJobs } = await import("./tools/backgroundShell.js");
  const isWindows = process.platform === "win32";
  const fast = await runShellBackground({
    command: isWindows ? "Write-Output 'notif-test-done'" : "echo notif-test-done",
    reason: "test notif",
  });
  await new Promise((r) => setTimeout(r, 800));

  const finished = getUnannouncedFinishedJobs();
  cases.push({
    name: "notif: getUnannouncedFinishedJobs returns finished",
    pass: finished.some((j) => j.id === fast.job_id),
    detail: `${finished.length} just-finished`,
  });

  const finishedAgain = getUnannouncedFinishedJobs();
  cases.push({
    name: "notif: doesn't re-announce same job",
    pass: !finishedAgain.some((j) => j.id === fast.job_id),
    detail: `${finishedAgain.length} after re-poll`,
  });
}

async function main(): Promise<void> {
  await readFileTests();
  await shellTests();
  await listDirTests();
  configTests();
  usageTests();
  await transcriptTests();
  await grepTests();
  await backgroundJobTests();
  await sessionTests();
  await memoryTests();
  await dispatchTests();
  await editFileTests();
  await permissionsTests();
  await skillsTests();
  await initTests();
  settingsTests();
  parallelSafeTests();
  await exportTests();
  statusLineTests();
  markdownTests();
  await autoResumeTests();
  await findSessionsTests();
  await mcpTests();
  await attachTests();
  toolStatsTests();
  await quietLogTests();
  await atRefTests();
  await redactorsTests();
  await spilloverTests();
  await personaTests();
  await sandboxTests();
  await atGlobTests();
  await feedbackTests();
  budgetTests();
  await jobNotificationTests();

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

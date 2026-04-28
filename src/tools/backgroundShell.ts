import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { confirm } from "../confirm.js";
import { log } from "../log.js";
import { redact } from "../redactors.js";

const MAX_OUTPUT_BYTES = 200_000;

const DESTRUCTIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\b\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|-[a-zA-Z]+\s+)*/, reason: "rm with recursive/force flags" },
  { pattern: /\bRemove-Item\b/i, reason: "PowerShell Remove-Item" },
  { pattern: /\bformat\b\s+[a-zA-Z]:/i, reason: "drive format" },
  { pattern: /\bmkfs(?:\.|\s)/i, reason: "mkfs filesystem creation" },
  { pattern: /\bdd\s+if=/i, reason: "dd write" },
  { pattern: /\b(?:apt|apt-get|yum|dnf|pacman)\s+(?:remove|purge|autoremove)\b/i, reason: "package removal" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: "shutdown/reboot" },
  { pattern: /\bdiskpart\b/i, reason: "diskpart" },
];

interface Job {
  id: string;
  command: string;
  startedAt: number;
  child: ChildProcess;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  doneAt: number | null;
  killed: boolean;
}

const jobs = new Map<string, Job>();
let nextId = 1;
const announcedDone = new Set<string>();

export function getUnannouncedFinishedJobs(): { id: string; command: string; exit_code: number | null; elapsed_ms: number; killed: boolean }[] {
  const out: { id: string; command: string; exit_code: number | null; elapsed_ms: number; killed: boolean }[] = [];
  for (const job of jobs.values()) {
    if (job.doneAt !== null && !announcedDone.has(job.id)) {
      announcedDone.add(job.id);
      out.push({
        id: job.id,
        command: job.command,
        exit_code: job.exitCode,
        elapsed_ms: job.doneAt - job.startedAt,
        killed: job.killed,
      });
    }
  }
  return out;
}

export interface ShellBgInput {
  command: string;
  reason?: string;
}

export interface ShellBgResult {
  ok: boolean;
  job_id?: string;
  command?: string;
  cancelled?: boolean;
  error?: string;
}

function looksDestructive(command: string): string | null {
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export async function runShellBackground(input: ShellBgInput): Promise<ShellBgResult> {
  const command = input.command;
  log();
  log(chalk.cyan("$ ") + chalk.white(command) + chalk.dim(" (background)"));
  if (input.reason) log(chalk.dim(`  reason: ${input.reason}`));

  const danger = looksDestructive(command);
  if (danger) {
    log(chalk.red(`  ⚠ flagged as potentially destructive: ${danger}`));
    const ok = await confirm("  Run this command in the background?");
    if (!ok) {
      log(chalk.dim("  skipped by user"));
      return { ok: false, cancelled: true, error: "User declined to run this command." };
    }
  }

  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "powershell.exe" : "/bin/sh";
  const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];

  const child = spawn(cmd, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const id = `job_${nextId++}`;
  const job: Job = {
    id,
    command,
    startedAt: Date.now(),
    child,
    stdoutChunks: [],
    stderrChunks: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    exitCode: null,
    signal: null,
    doneAt: null,
    killed: false,
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (job.stdoutBytes + chunk.length > MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - job.stdoutBytes;
      if (remaining > 0) {
        job.stdoutChunks.push(chunk.subarray(0, remaining));
        job.stdoutBytes += remaining;
      }
      return;
    }
    job.stdoutChunks.push(chunk);
    job.stdoutBytes += chunk.length;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (job.stderrBytes + chunk.length > MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - job.stderrBytes;
      if (remaining > 0) {
        job.stderrChunks.push(chunk.subarray(0, remaining));
        job.stderrBytes += remaining;
      }
      return;
    }
    job.stderrChunks.push(chunk);
    job.stderrBytes += chunk.length;
  });
  // `exit` fires the moment the process is gone; `close` only fires once
  // stdio drains, which on Linux can be much later when a shell child has
  // grandchildren (e.g. /bin/sh -c "sleep 30") that inherit the pipes.
  // We want state="killed" to reflect promptly, so use `exit` here.
  child.on("exit", (code, signal) => {
    if (job.doneAt !== null) return;
    job.exitCode = code;
    job.signal = signal;
    job.doneAt = Date.now();
  });
  child.on("error", () => {
    if (job.doneAt !== null) return;
    job.exitCode = -1;
    job.doneAt = Date.now();
  });

  jobs.set(id, job);
  log(chalk.dim(`  started ${id} (pid ${child.pid ?? "?"})`));
  return { ok: true, job_id: id, command };
}

export interface ShellStatusInput {
  job_id: string;
  output_max_chars?: number;
}

export interface ShellStatusResult {
  ok: boolean;
  job_id: string;
  state: "running" | "exited" | "killed";
  exit_code: number | null;
  signal: string | null;
  command?: string;
  elapsed_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  error?: string;
}

function snapshotOutput(job: Job, maxChars: number): { out: string; err: string; outTrunc: boolean; errTrunc: boolean } {
  const oRaw = Buffer.concat(job.stdoutChunks, job.stdoutBytes).toString("utf8");
  const eRaw = Buffer.concat(job.stderrChunks, job.stderrBytes).toString("utf8");
  const oSlice = oRaw.length > maxChars ? oRaw.slice(oRaw.length - maxChars) : oRaw;
  const eSlice = eRaw.length > maxChars ? eRaw.slice(eRaw.length - maxChars) : eRaw;
  return {
    out: redact(oSlice).redacted,
    err: redact(eSlice).redacted,
    outTrunc: oRaw.length > maxChars || job.stdoutBytes >= MAX_OUTPUT_BYTES,
    errTrunc: eRaw.length > maxChars || job.stderrBytes >= MAX_OUTPUT_BYTES,
  };
}

export async function runShellStatus(input: ShellStatusInput): Promise<ShellStatusResult> {
  const job = jobs.get(input.job_id);
  if (!job) {
    return {
      ok: false,
      job_id: input.job_id,
      state: "exited",
      exit_code: null,
      signal: null,
      elapsed_ms: 0,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      error: `unknown job_id: ${input.job_id}`,
    };
  }
  const maxChars = input.output_max_chars ?? 8000;
  const snap = snapshotOutput(job, maxChars);
  const elapsed = (job.doneAt ?? Date.now()) - job.startedAt;
  const state: ShellStatusResult["state"] = job.doneAt === null ? "running" : job.killed ? "killed" : "exited";

  log();
  log(chalk.cyan("status ") + chalk.white(job.id) + chalk.dim(` (${state}, ${elapsed}ms)`));

  return {
    ok: true,
    job_id: job.id,
    state,
    exit_code: job.exitCode,
    signal: job.signal,
    command: job.command,
    elapsed_ms: elapsed,
    stdout: snap.out,
    stderr: snap.err,
    stdout_truncated: snap.outTrunc,
    stderr_truncated: snap.errTrunc,
  };
}

export interface ShellKillInput {
  job_id: string;
}

export interface ShellKillResult {
  ok: boolean;
  job_id: string;
  killed: boolean;
  error?: string;
}

export async function runShellKill(input: ShellKillInput): Promise<ShellKillResult> {
  const job = jobs.get(input.job_id);
  if (!job) {
    return { ok: false, job_id: input.job_id, killed: false, error: `unknown job_id: ${input.job_id}` };
  }
  if (job.doneAt !== null) {
    return { ok: true, job_id: job.id, killed: false, error: "job already exited" };
  }
  log();
  log(chalk.cyan("kill ") + chalk.white(job.id));
  job.killed = true;
  try {
    job.child.kill("SIGKILL");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, job_id: job.id, killed: false, error: msg };
  }
  // Wait briefly for the exit event to fire so subsequent shell_status
  // calls observe the job as "killed" rather than racing with the OS.
  // SIGKILL is unblockable so the child dies promptly; the 2s ceiling is
  // a safety net for severely overloaded runners.
  await new Promise<void>((resolve) => {
    if (job.doneAt !== null) return resolve();
    const timer = setTimeout(resolve, 2000);
    job.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { ok: true, job_id: job.id, killed: true };
}

export function listJobs(): Array<{ id: string; command: string; state: string; elapsed_ms: number; exit_code: number | null }> {
  const out: Array<{ id: string; command: string; state: string; elapsed_ms: number; exit_code: number | null }> = [];
  for (const job of jobs.values()) {
    out.push({
      id: job.id,
      command: job.command,
      state: job.doneAt === null ? "running" : job.killed ? "killed" : "exited",
      elapsed_ms: (job.doneAt ?? Date.now()) - job.startedAt,
      exit_code: job.exitCode,
    });
  }
  return out;
}

export const SHELL_BG_TOOL_DEFINITION = {
  name: "shell_background",
  description:
    "Run a shell command in the background, returning immediately with a job_id. Use for long-running operations (chkdsk, sfc /scannow, package builds, traceroute, log tails) so the conversation isn't blocked. Output is captured up to 200KB. Destructive commands still require user confirmation. Then use shell_status to check progress and shell_kill to abort.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "The shell command to run." },
      reason: { type: "string", description: "One-line explanation." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const SHELL_STATUS_TOOL_DEFINITION = {
  name: "shell_status",
  description:
    "Check the state of a background shell job by job_id. Returns running/exited/killed, exit code, elapsed time, and the most recent stdout/stderr output (last N chars).",
  input_schema: {
    type: "object" as const,
    properties: {
      job_id: { type: "string", description: "The job_id returned by shell_background." },
      output_max_chars: { type: "integer", description: "Max chars of stdout/stderr to return (default 8000).", minimum: 100 },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};

export const SHELL_KILL_TOOL_DEFINITION = {
  name: "shell_kill",
  description: "Forcibly terminate a background shell job by job_id (SIGKILL).",
  input_schema: {
    type: "object" as const,
    properties: {
      job_id: { type: "string", description: "The job_id returned by shell_background." },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};

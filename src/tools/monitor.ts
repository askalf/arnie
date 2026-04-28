import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";
import { redact } from "../redactors.js";

const MAX_ITERATIONS = 30;
const MAX_INTERVAL_S = 60;
const MIN_INTERVAL_S = 1;
const PER_RUN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 20_000;

export interface MonitorInput {
  command: string;
  iterations?: number;
  interval_seconds?: number;
  reason?: string;
}

export interface MonitorIteration {
  index: number;
  ts: string;
  exit_code: number | null;
  changed: boolean;
  output: string;
}

export interface MonitorResult {
  ok: boolean;
  command: string;
  total_iterations: number;
  iterations_with_changes: MonitorIteration[];
  duration_ms: number;
  error?: string;
}

function runOnce(command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "powershell.exe" : "/bin/sh";
    const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
    const child = spawn(cmd, args, { env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, PER_RUN_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      if (stdoutBytes + c.length > MAX_OUTPUT_BYTES) return;
      stdout.push(c);
      stdoutBytes += c.length;
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderrBytes + c.length > MAX_OUTPUT_BYTES) return;
      stderr.push(c);
      stderrBytes += c.length;
    });
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
  });
}

export async function runMonitor(input: MonitorInput): Promise<MonitorResult> {
  const iterations = Math.min(input.iterations ?? 5, MAX_ITERATIONS);
  const interval = Math.max(Math.min(input.interval_seconds ?? 2, MAX_INTERVAL_S), MIN_INTERVAL_S);

  log();
  log(chalk.cyan("monitor ") + chalk.white(input.command) + chalk.dim(` (${iterations}× every ${interval}s)`));
  if (input.reason) log(chalk.dim(`  reason: ${input.reason}`));

  const start = Date.now();
  const changes: MonitorIteration[] = [];
  let last = "<<INITIAL>>";

  for (let i = 0; i < iterations; i++) {
    const r = await runOnce(input.command);
    const combined = redact((r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "")).trim()).redacted;
    const changed = combined !== last;
    if (changed) {
      changes.push({
        index: i + 1,
        ts: new Date().toISOString(),
        exit_code: r.code,
        changed: true,
        output: combined,
      });
      last = combined;
      log(chalk.dim(`  iter ${i + 1}/${iterations}: changed (${combined.length} chars)`));
    } else {
      log(chalk.dim(`  iter ${i + 1}/${iterations}: unchanged`));
    }
    if (i < iterations - 1) {
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  }

  return {
    ok: true,
    command: input.command,
    total_iterations: iterations,
    iterations_with_changes: changes,
    duration_ms: Date.now() - start,
  };
}

export const MONITOR_TOOL_DEFINITION = {
  name: "monitor",
  description:
    "Run a shell command multiple times on a fixed interval, returning only the iterations where the output differed from the previous one. Use this for 'watch this for changes' tasks — service status, queue length, log tail, file size, network state — without blocking the conversation. Bounded: max 30 iterations, max 60s interval, 30s per-run timeout. Output is redacted before being returned. Cross-platform (PowerShell on Windows, /bin/sh elsewhere).",
  input_schema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Command to run on each iteration." },
      iterations: { type: "integer", description: "Number of times to run (default 5, max 30).", minimum: 1, maximum: MAX_ITERATIONS },
      interval_seconds: { type: "integer", description: "Seconds between runs (default 2, max 60).", minimum: MIN_INTERVAL_S, maximum: MAX_INTERVAL_S },
      reason: { type: "string", description: "One-line explanation." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

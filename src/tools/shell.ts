import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { confirm } from "../confirm.js";
import { evaluateCommand, type PermissionsConfig } from "../permissions.js";
import { log } from "../log.js";

let permissions: PermissionsConfig = { allow: [], deny: [], source: null };

export function setShellPermissions(config: PermissionsConfig): void {
  permissions = config;
}

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const DESTRUCTIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\b\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|-[a-zA-Z]+\s+)*/, reason: "rm with recursive/force flags" },
  { pattern: /\bdel\b\s+\/[sSqQfF]/i, reason: "del with /s, /q, or /f" },
  { pattern: /\brmdir\b\s+\/[sSqQ]/i, reason: "rmdir with /s or /q" },
  { pattern: /\bRemove-Item\b/i, reason: "PowerShell Remove-Item" },
  { pattern: /\bformat\b\s+[a-zA-Z]:/i, reason: "drive format" },
  { pattern: /\bmkfs(?:\.|\s)/i, reason: "mkfs filesystem creation" },
  { pattern: /\bdd\s+if=/i, reason: "dd write" },
  { pattern: /\breg\s+(?:delete|add)/i, reason: "registry modification" },
  { pattern: /\bRemove-ItemProperty\b/i, reason: "registry property removal" },
  { pattern: /\b(?:apt|apt-get|yum|dnf|pacman)\s+(?:remove|purge|autoremove)\b/i, reason: "package removal" },
  { pattern: /\bnpm\s+uninstall\s+-g\b/i, reason: "global npm uninstall" },
  { pattern: /\bpip\s+uninstall\b/i, reason: "pip uninstall" },
  { pattern: /\bwinget\s+uninstall\b/i, reason: "winget uninstall" },
  { pattern: /\bchoco\s+uninstall\b/i, reason: "choco uninstall" },
  { pattern: /\btaskkill\s+\/[fF]/i, reason: "forced taskkill" },
  { pattern: /\bkill\s+-9\b/, reason: "kill -9" },
  { pattern: /\bStop-Process\b.*-Force/i, reason: "PowerShell Stop-Process -Force" },
  { pattern: /\bStop-Service\b/i, reason: "service stop" },
  { pattern: /\bsc\s+(?:delete|stop)\b/i, reason: "service control delete/stop" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: "shutdown/reboot" },
  { pattern: /\bRestart-Computer\b/i, reason: "PowerShell restart" },
  { pattern: /\bchmod\s+(?:-R\s+)?[0-7]{3,4}\s+\//, reason: "chmod on root paths" },
  { pattern: /\bchown\s+-R\b/, reason: "recursive chown" },
  { pattern: /\bicacls\b/i, reason: "icacls permissions change" },
  { pattern: /\btakeown\b/i, reason: "takeown" },
  { pattern: /\bnetsh\s+interface\b/i, reason: "netsh interface change" },
  { pattern: /\bDisable-NetAdapter\b/i, reason: "disable network adapter" },
  { pattern: /\b(?:>|>>)\s*\/dev\/(?:sd[a-z]|nvme|disk)/i, reason: "raw disk write" },
  { pattern: /\bdiskpart\b/i, reason: "diskpart" },
  { pattern: /\bbcdedit\b/i, reason: "boot configuration edit" },
];

export interface ShellInput {
  command: string;
  timeout_seconds?: number;
  reason?: string;
}

export interface ShellResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled?: boolean;
}

function looksDestructive(command: string): string | null {
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

function truncateOutput(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.length <= MAX_OUTPUT_BYTES) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  const head = buf.subarray(0, MAX_OUTPUT_BYTES * 0.6).toString("utf8");
  const tail = buf.subarray(buf.length - MAX_OUTPUT_BYTES * 0.4).toString("utf8");
  return {
    text: `${head}\n\n... [${buf.length - MAX_OUTPUT_BYTES} bytes truncated] ...\n\n${tail}`,
    truncated: true,
  };
}

export async function runShell(input: ShellInput): Promise<ShellResult> {
  const command = input.command;
  const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;

  log();
  log(chalk.cyan("$ ") + chalk.white(command));
  if (input.reason) log(chalk.dim(`  reason: ${input.reason}`));

  const decision = evaluateCommand(command, permissions);
  if (decision.decision === "deny") {
    log(chalk.red(`  ✕ denied by permissions config: ${decision.reason ?? decision.rule}`));
    return {
      ok: false,
      exit_code: null,
      stdout: "",
      stderr: `Command denied by permissions config (rule: ${decision.rule}). ${decision.reason ?? ""} Try a different approach.`,
      truncated: false,
      cancelled: true,
    };
  }

  const danger = looksDestructive(command);
  if (danger && decision.decision !== "allow") {
    log(chalk.red(`  ⚠ flagged as potentially destructive: ${danger}`));
    const ok = await confirm("  Run this command?");
    if (!ok) {
      log(chalk.dim("  skipped by user"));
      return {
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: "User declined to run this command. Try a different approach or ask the user what they would prefer.",
        truncated: false,
        cancelled: true,
      };
    }
  } else if (decision.decision === "allow" && danger) {
    log(chalk.dim(`  pre-approved by permissions config (rule: ${decision.rule}); skipping confirmation`));
  }

  const isWindows = process.platform === "win32";
  const shell = isWindows
    ? { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
    : { cmd: "/bin/sh", args: ["-c", command] };

  return new Promise<ShellResult>((resolve) => {
    const child = spawn(shell.cmd, shell.args, {
      cwd: process.cwd(),
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: `spawn error: ${err.message}`,
        truncated: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(stdoutChunks, stdoutBytes);
      const stderrBuf = Buffer.concat(stderrChunks, stderrBytes);
      const out = truncateOutput(stdoutBuf);
      const err = truncateOutput(stderrBuf);
      const summary = `exit ${code ?? "killed"}`;
      log(chalk.dim(`  ${summary}`));
      resolve({
        ok: code === 0,
        exit_code: code,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}

export const SHELL_TOOL_DEFINITION = {
  name: "shell",
  description:
    "Run a shell command on the user's machine. On Windows runs via PowerShell (-NoProfile -NonInteractive); on macOS/Linux via /bin/sh. Use for diagnostics, file inspection, package queries, network checks, etc. Output is captured and returned. Commands matched as potentially destructive (deletes, format, kills, registry edits, package removals, shutdown, etc.) require user confirmation before running. Provide a brief reason so the user knows why.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
      timeout_seconds: {
        type: "integer",
        description: "Timeout in seconds (default 30, max 300). Use longer values for known-slow operations.",
        minimum: 1,
        maximum: 300,
      },
      reason: {
        type: "string",
        description: "One-line explanation of what this command does and why you're running it.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

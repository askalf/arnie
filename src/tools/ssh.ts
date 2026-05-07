import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import chalk from "chalk";
import { confirm } from "../confirm.js";
import { log } from "../log.js";
import { redact } from "../redactors.js";
import { checkWrite } from "../sandbox.js";
import {
  looksDestructive,
  spillover,
  truncateOutput,
  SPILLOVER_THRESHOLD_BYTES,
} from "./shell.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_S = 10;

// We rely on the system `ssh` binary so the user's ~/.ssh/config, agent, keys,
// known_hosts, and ProxyJump rules all "just work" without arnie reimplementing
// any of it. BatchMode=yes makes us fail fast instead of hanging on a password
// prompt — interactive auth doesn't make sense for a tool the model invokes.
const SSH_BASE_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
  "-o",
  "StrictHostKeyChecking=accept-new",
];

function parseHost(input: string): { sshArgs: string[] } {
  // Accept "alias", "user@host", "host:port", "user@host:port".
  // IPv6 literals contain colons; if we see more than one ':' we treat the
  // whole thing as a host and let ssh handle it (users with IPv6 should use
  // an ssh_config alias anyway). Otherwise a trailing :digits is a port.
  const m = /^(.+?):(\d+)$/.exec(input);
  if (m && !m[1].includes(":")) {
    return { sshArgs: ["-p", m[2], m[1]] };
  }
  return { sshArgs: [input] };
}

export interface SshExecInput {
  host: string;
  command: string;
  timeout_seconds?: number;
  reason?: string;
}

export interface SshExecResult {
  ok: boolean;
  host: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled?: boolean;
  stdout_full_path?: string;
  stderr_full_path?: string;
}

export async function runSshExec(input: SshExecInput): Promise<SshExecResult> {
  const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;

  log();
  log(chalk.cyan("ssh ") + chalk.white(input.host) + chalk.dim(" $ ") + chalk.white(input.command));
  if (input.reason) log(chalk.dim(`  reason: ${input.reason}`));

  // Destructive check applies to the *remote* command — `ssh box rm -rf /`
  // is just as bad as running it locally.
  const danger = looksDestructive(input.command);
  if (danger) {
    log(chalk.red(`  ⚠ flagged as potentially destructive on remote: ${danger}`));
    const ok = await confirm(`  Run this command on ${input.host}?`);
    if (!ok) {
      log(chalk.dim("  skipped by user"));
      return {
        ok: false,
        host: input.host,
        exit_code: null,
        stdout: "",
        stderr: "User declined to run this command on the remote host. Try a different approach.",
        truncated: false,
        cancelled: true,
      };
    }
  }

  const { sshArgs } = parseHost(input.host);
  const args = [...SSH_BASE_OPTS, ...sshArgs, input.command];

  return new Promise<SshExecResult>((resolve) => {
    const child = spawn("ssh", args, { env: process.env });

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
        host: input.host,
        exit_code: null,
        stdout: "",
        stderr: `spawn error: ${err.message} (is the ssh binary installed and on PATH?)`,
        truncated: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      void (async () => {
        const stdoutBuf = Buffer.concat(stdoutChunks, stdoutBytes);
        const stderrBuf = Buffer.concat(stderrChunks, stderrBytes);
        const out = truncateOutput(stdoutBuf);
        const err = truncateOutput(stderrBuf);
        log(chalk.dim(`  exit ${code ?? "killed"}`));
        const redactedOut = redact(out.text);
        const redactedErr = redact(err.text);
        if (redactedOut.hits + redactedErr.hits > 0) {
          log(chalk.dim(`  ${redactedOut.hits + redactedErr.hits} secret(s) redacted from output`));
        }

        let stdoutFullPath: string | undefined;
        let stderrFullPath: string | undefined;
        if (stdoutBuf.length > SPILLOVER_THRESHOLD_BYTES) {
          try {
            stdoutFullPath = await spillover("ssh-stdout", redact(stdoutBuf.toString("utf8")).redacted);
            log(chalk.dim(`  stdout spillover: ${stdoutFullPath}`));
          } catch {
            // best-effort
          }
        }
        if (stderrBuf.length > SPILLOVER_THRESHOLD_BYTES) {
          try {
            stderrFullPath = await spillover("ssh-stderr", redact(stderrBuf.toString("utf8")).redacted);
            log(chalk.dim(`  stderr spillover: ${stderrFullPath}`));
          } catch {
            // best-effort
          }
        }

        // ssh exit code 255 means ssh itself failed (auth, connect, key) —
        // distinct from a non-zero remote command exit. Surface that hint
        // so the model doesn't try to debug the remote when the connection
        // never landed.
        const sshFailed = code === 255;
        const stderrWithHint = sshFailed
          ? `${redactedErr.redacted}\n[ssh exit 255 — connection or auth failed before the remote command ran. Common causes: host unreachable, key not loaded in agent, BatchMode rejected password auth, host key changed.]`
          : redactedErr.redacted;

        resolve({
          ok: code === 0,
          host: input.host,
          exit_code: code,
          stdout: redactedOut.redacted,
          stderr: stderrWithHint,
          truncated: out.truncated || err.truncated,
          stdout_full_path: stdoutFullPath,
          stderr_full_path: stderrFullPath,
        });
      })();
    });
  });
}

export const SSH_EXEC_TOOL_DEFINITION = {
  name: "ssh_exec",
  description:
    "Run a command on a remote host via ssh. Uses the system `ssh` binary, so ~/.ssh/config aliases, agent keys, ProxyJump, and known_hosts all apply. host can be an alias, `user@host`, `host:port`, or `user@host:port`. Connect timeout 10s, BatchMode=yes (no password prompts). Destructive commands on the remote require user confirmation. Output is captured, redacted, and spilled to a local temp file if > 100KB. Use this instead of asking the user to ssh in manually. ssh exit 255 means the connection itself failed.",
  input_schema: {
    type: "object" as const,
    properties: {
      host: {
        type: "string",
        description: "ssh-config alias, `user@host`, `host:port`, or `user@host:port`.",
      },
      command: {
        type: "string",
        description: "Command to run on the remote host (parsed by the remote shell).",
      },
      timeout_seconds: {
        type: "integer",
        description: "Timeout in seconds (default 30, max 300).",
        minimum: 1,
        maximum: 300,
      },
      reason: {
        type: "string",
        description: "One-line explanation of why this command is being run on this host.",
      },
    },
    required: ["host", "command"],
    additionalProperties: false,
  },
};

export interface ScpGetInput {
  host: string;
  remote_path: string;
  local_path?: string;
}

export interface ScpGetResult {
  ok: boolean;
  host: string;
  remote_path: string;
  local_path: string;
  bytes?: number;
  error?: string;
}

export async function runScpGet(input: ScpGetInput): Promise<ScpGetResult> {
  log();
  log(chalk.cyan("scp ") + chalk.white(`${input.host}:${input.remote_path}`) + chalk.dim(" → "));

  let localPath: string;
  if (input.local_path) {
    localPath = path.resolve(input.local_path);
    const sb = checkWrite(localPath);
    if (!sb.allowed) {
      log(chalk.red(`  ✕ sandbox: ${sb.reason}`));
      return {
        ok: false,
        host: input.host,
        remote_path: input.remote_path,
        local_path: localPath,
        error: `sandbox denied: ${sb.reason}`,
      };
    }
  } else {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arnie-scp-"));
    localPath = path.join(dir, path.basename(input.remote_path) || "remote-file");
  }
  log(chalk.white(localPath));

  const { sshArgs } = parseHost(input.host);
  // scp uses -P (capital) for port, not -p. parseHost gives us ["-p", port, host]
  // for ssh; translate.
  const scpArgs: string[] = [];
  if (sshArgs[0] === "-p") {
    scpArgs.push("-P", sshArgs[1]);
    scpArgs.push("-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`, "-o", "StrictHostKeyChecking=accept-new");
    scpArgs.push(`${sshArgs[2]}:${input.remote_path}`, localPath);
  } else {
    scpArgs.push("-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`, "-o", "StrictHostKeyChecking=accept-new");
    scpArgs.push(`${sshArgs[0]}:${input.remote_path}`, localPath);
  }

  return new Promise<ScpGetResult>((resolve) => {
    const child = spawn("scp", scpArgs, { env: process.env });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        host: input.host,
        remote_path: input.remote_path,
        local_path: localPath,
        error: `spawn error: ${err.message} (is the scp binary installed?)`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      void (async () => {
        if (code !== 0) {
          const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
          log(chalk.red(`  exit ${code ?? "killed"}: ${stderrText.slice(-300)}`));
          resolve({
            ok: false,
            host: input.host,
            remote_path: input.remote_path,
            local_path: localPath,
            error: stderrText.slice(-1500) || `scp exit ${code}`,
          });
          return;
        }
        try {
          const stat = await fs.stat(localPath);
          log(chalk.green(`  fetched ${stat.size} bytes`));
          resolve({
            ok: true,
            host: input.host,
            remote_path: input.remote_path,
            local_path: localPath,
            bytes: stat.size,
          });
        } catch (err) {
          resolve({
            ok: false,
            host: input.host,
            remote_path: input.remote_path,
            local_path: localPath,
            error: `local stat failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    });
  });
}

export const SCP_GET_TOOL_DEFINITION = {
  name: "scp_get",
  description:
    "Fetch a remote file to a local temp path via scp, then return the local path. Use this for pulling logs, configs, or core dumps off a remote host so you can read_file or grep them locally without round-tripping through ssh_exec. host accepts the same forms as ssh_exec. local_path defaults to a fresh temp file; if specified, sandbox write rules apply. 60s timeout.",
  input_schema: {
    type: "object" as const,
    properties: {
      host: {
        type: "string",
        description: "ssh-config alias, `user@host`, `host:port`, or `user@host:port`.",
      },
      remote_path: {
        type: "string",
        description: "Absolute path on the remote host.",
      },
      local_path: {
        type: "string",
        description: "Optional local destination. Defaults to a fresh temp file.",
      },
    },
    required: ["host", "remote_path"],
    additionalProperties: false,
  },
};

export interface SshHostsInput {
  // no inputs — list everything we can find
}

export interface SshHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  source: string;
}

export interface SshHostsResult {
  ok: boolean;
  hosts: SshHost[];
  source_files: string[];
  note?: string;
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseSshConfig(text: string, source: string): SshHost[] {
  // Best-effort: handle Host blocks, skip wildcards, ignore Match/Include.
  // The Host directive can list multiple patterns; we emit one entry per
  // non-wildcard pattern. Keys are case-insensitive.
  const lines = text.split(/\r?\n/);
  const hosts: SshHost[] = [];
  let current: { aliases: string[]; settings: Record<string, string> } | null = null;

  const flush = () => {
    if (!current) return;
    for (const alias of current.aliases) {
      if (alias.includes("*") || alias.includes("?") || alias === "!*") continue;
      const portStr = current.settings.port;
      const port = portStr && /^\d+$/.test(portStr) ? Number(portStr) : undefined;
      hosts.push({
        alias,
        hostname: current.settings.hostname,
        user: current.settings.user,
        port,
        source,
      });
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    const spIdx = line.search(/\s/);
    let key: string;
    let value: string;
    if (eqIdx >= 0 && (spIdx < 0 || eqIdx < spIdx)) {
      key = line.slice(0, eqIdx).trim().toLowerCase();
      value = line.slice(eqIdx + 1).trim();
    } else if (spIdx > 0) {
      key = line.slice(0, spIdx).toLowerCase();
      value = line.slice(spIdx + 1).trim();
    } else {
      continue;
    }
    if (key === "host") {
      flush();
      current = { aliases: value.split(/\s+/).filter(Boolean), settings: {} };
    } else if (key === "match") {
      flush();
      current = null; // Match blocks aren't simple aliases
    } else if (current) {
      current.settings[key] = value;
    }
  }
  flush();
  return hosts;
}

export async function runSshHosts(_input: SshHostsInput): Promise<SshHostsResult> {
  log();
  log(chalk.cyan("ssh hosts"));

  const userConfig = path.join(os.homedir(), ".ssh", "config");
  const sysConfig = "/etc/ssh/ssh_config";

  const userText = await readMaybe(userConfig);
  const sysText = process.platform === "win32" ? null : await readMaybe(sysConfig);

  const sources: string[] = [];
  let hosts: SshHost[] = [];
  if (userText !== null) {
    sources.push(userConfig);
    hosts = hosts.concat(parseSshConfig(userText, userConfig));
  }
  if (sysText !== null) {
    sources.push(sysConfig);
    hosts = hosts.concat(parseSshConfig(sysText, sysConfig));
  }

  log(chalk.dim(`  ${hosts.length} host(s) from ${sources.length} file(s)`));

  return {
    ok: true,
    hosts,
    source_files: sources,
    note: "Wildcards (Host * patterns) and Match blocks are skipped. Include directives are not followed.",
  };
}

export const SSH_HOSTS_TOOL_DEFINITION = {
  name: "ssh_hosts",
  description:
    "List ssh hosts configured in ~/.ssh/config (and /etc/ssh/ssh_config on non-Windows). Read-only. Use this to discover what aliases the user has set up before asking them. Returns alias, hostname, user, port. Wildcards and Match blocks are skipped; Include directives aren't followed.",
  input_schema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
};

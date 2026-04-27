import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";

const TIMEOUT_MS = 15_000;

export interface NetworkCheckInput {
  host: string;
  port?: number;
  ping?: boolean;
}

export interface NetworkCheckResult {
  ok: boolean;
  host: string;
  port: number | null;
  ping?: { reachable: boolean; output: string };
  port_check?: { open: boolean | null; output: string };
  error?: string;
}

function spawnCapture(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
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
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function runNetworkCheck(input: NetworkCheckInput): Promise<NetworkCheckResult> {
  log();
  log(chalk.cyan("net ") + chalk.white(input.host) + (input.port ? chalk.dim(`:${input.port}`) : ""));

  const isWindows = process.platform === "win32";
  const result: NetworkCheckResult = {
    ok: true,
    host: input.host,
    port: input.port ?? null,
  };

  const wantPing = input.ping ?? true;
  if (wantPing) {
    const args = isWindows ? ["-n", "2", "-w", "2000", input.host] : ["-c", "2", "-W", "2", input.host];
    const r = await spawnCapture(isWindows ? "ping" : "ping", args);
    result.ping = {
      reachable: r.code === 0,
      output: (r.stdout + r.stderr).trim().slice(-1500),
    };
    log(chalk.dim(`  ping ${result.ping.reachable ? "ok" : "fail"}`));
  }

  if (input.port !== undefined) {
    if (isWindows) {
      const ps = `try { $r = Test-NetConnection -ComputerName '${input.host.replace(/'/g, "''")}' -Port ${input.port} -WarningAction SilentlyContinue; "TcpTestSucceeded=$($r.TcpTestSucceeded) RemoteAddress=$($r.RemoteAddress) PingSucceeded=$($r.PingSucceeded)" } catch { "ERROR: $_" }`;
      const r = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      const out = (r.stdout + r.stderr).trim();
      const open = /TcpTestSucceeded=True/i.test(out) ? true : /TcpTestSucceeded=False/i.test(out) ? false : null;
      result.port_check = { open, output: out.slice(-1500) };
      log(chalk.dim(`  port ${input.port} ${open === true ? "open" : open === false ? "closed/filtered" : "unknown"}`));
    } else {
      const sh = `if command -v nc >/dev/null 2>&1; then nc -z -w 3 '${input.host.replace(/'/g, "'\\''")}' ${input.port} && echo "OPEN" || echo "CLOSED"; elif command -v bash >/dev/null && bash -c 'true </dev/tcp/127.0.0.1/0' 2>/dev/null; then bash -c "exec 3<>/dev/tcp/${input.host}/${input.port}" >/dev/null 2>&1 && echo "OPEN" || echo "CLOSED"; else echo "no nc or bash /dev/tcp available"; fi`;
      const r = await spawnCapture("/bin/sh", ["-c", sh]);
      const out = (r.stdout + r.stderr).trim();
      const open = /\bOPEN\b/.test(out) ? true : /\bCLOSED\b/.test(out) ? false : null;
      result.port_check = { open, output: out.slice(-1500) };
      log(chalk.dim(`  port ${input.port} ${open === true ? "open" : open === false ? "closed" : "unknown"}`));
    }
  }

  return result;
}

export const NETWORK_CHECK_TOOL_DEFINITION = {
  name: "network_check",
  description:
    "Probe network reachability of a host: ICMP ping (2 packets) and optional TCP port check. On Windows uses ping + Test-NetConnection; on macOS/Linux uses ping + nc. Use this instead of asking the user to run network diagnostics manually.",
  input_schema: {
    type: "object" as const,
    properties: {
      host: { type: "string", description: "Hostname or IP." },
      port: { type: "integer", description: "Optional TCP port to test.", minimum: 1, maximum: 65535 },
      ping: { type: "boolean", description: "Whether to ICMP ping (default true)." },
    },
    required: ["host"],
    additionalProperties: false,
  },
};

export interface ServiceCheckInput {
  name?: string;
  filter?: "running" | "stopped" | "all";
}

export interface ServiceCheckRow {
  name: string;
  status: string;
  display_name?: string;
  start_type?: string;
}

export interface ServiceCheckResult {
  ok: boolean;
  platform: string;
  rows: ServiceCheckRow[];
  truncated: boolean;
  error?: string;
}

export async function runServiceCheck(input: ServiceCheckInput): Promise<ServiceCheckResult> {
  log();
  log(chalk.cyan("services ") + chalk.dim(`name=${input.name ?? "*"} filter=${input.filter ?? "all"}`));

  const isWindows = process.platform === "win32";
  if (isWindows) {
    const filterClause =
      input.filter === "running"
        ? "Where-Object { $_.Status -eq 'Running' }"
        : input.filter === "stopped"
          ? "Where-Object { $_.Status -eq 'Stopped' }"
          : "";
    const namePart = input.name ? `-Name '${input.name.replace(/'/g, "''")}*' ` : "";
    const ps = `Get-Service ${namePart}${filterClause ? "| " + filterClause : ""} | Select-Object -First 100 Name, Status, DisplayName, StartType | ConvertTo-Json -Compress`;
    const r = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const out = (r.stdout || "").trim();
    if (r.code !== 0 && !out) {
      return { ok: false, platform: "windows", rows: [], truncated: false, error: r.stderr.trim() };
    }
    let parsed: unknown;
    try {
      parsed = out ? JSON.parse(out) : [];
    } catch (err) {
      return { ok: false, platform: "windows", rows: [], truncated: false, error: `parse error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const rows: ServiceCheckRow[] = arr.map((s: unknown) => {
      const o = s as Record<string, unknown>;
      const status = o.Status;
      const start = o.StartType;
      return {
        name: String(o.Name ?? ""),
        status: typeof status === "object" && status !== null ? String((status as { value?: unknown }).value ?? status) : String(status ?? ""),
        display_name: o.DisplayName ? String(o.DisplayName) : undefined,
        start_type: typeof start === "object" && start !== null ? String((start as { value?: unknown }).value ?? start) : start !== undefined ? String(start) : undefined,
      };
    });
    log(chalk.dim(`  ${rows.length} services`));
    return { ok: true, platform: "windows", rows, truncated: rows.length === 100 };
  }

  const isLinux = process.platform === "linux";
  if (isLinux) {
    const r = await spawnCapture("/bin/sh", [
      "-c",
      "systemctl --no-legend --no-pager list-units --type=service --all 2>/dev/null | head -200",
    ]);
    const lines = (r.stdout || "").split("\n").filter((l) => l.trim().length > 0);
    let rows: ServiceCheckRow[] = lines.map((l) => {
      const parts = l.split(/\s+/);
      return {
        name: parts[0] ?? "",
        status: parts[2] ?? "",
        display_name: parts.slice(4).join(" ") || undefined,
      };
    });
    if (input.name) rows = rows.filter((r) => r.name.toLowerCase().includes(input.name!.toLowerCase()));
    if (input.filter === "running") rows = rows.filter((r) => r.status === "running");
    if (input.filter === "stopped") rows = rows.filter((r) => r.status !== "running");
    log(chalk.dim(`  ${rows.length} services`));
    return { ok: true, platform: "linux", rows, truncated: rows.length === 200 };
  }

  return { ok: false, platform: process.platform, rows: [], truncated: false, error: `service_check not implemented for platform: ${process.platform}` };
}

export const SERVICE_CHECK_TOOL_DEFINITION = {
  name: "service_check",
  description:
    "List system services and their status. Windows: Get-Service. Linux: systemctl list-units --type=service. Optionally filter by service name (substring/prefix match) or by running/stopped state. Use this for 'is the spooler running?' / 'list stopped services' / etc., instead of shelling Get-Service manually.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Optional service name (prefix on Windows, substring on Linux)." },
      filter: { type: "string", enum: ["running", "stopped", "all"], description: "Filter by state. Default all." },
    },
    additionalProperties: false,
  },
};

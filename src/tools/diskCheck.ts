import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";

const TIMEOUT_MS = 10_000;

export interface DiskCheckInput {
  path?: string;
}

export interface DiskRow {
  name: string;
  mount?: string;
  filesystem?: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  percent_used: number;
}

export interface DiskCheckResult {
  ok: boolean;
  platform: string;
  rows: DiskRow[];
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

function bytesToGb(n: number): number {
  return Math.round((n / 1024 / 1024 / 1024) * 10) / 10;
}

export async function runDiskCheck(input: DiskCheckInput): Promise<DiskCheckResult> {
  log();
  log(chalk.cyan("disk ") + chalk.dim(input.path ? `path=${input.path}` : "all drives"));

  const isWindows = process.platform === "win32";

  if (isWindows) {
    const ps = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null -or $_.Free -ne $null } | ForEach-Object { $total = ($_.Used + $_.Free); $usedPct = if ($total -gt 0) { [math]::Round($_.Used / $total * 100, 1) } else { 0 }; [PSCustomObject]@{ Name=$_.Name; Root=$_.Root; Used=[long]$_.Used; Free=[long]$_.Free; Total=[long]$total; PercentUsed=$usedPct } } | ConvertTo-Json -Compress`;
    const r = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const out = (r.stdout || "").trim();
    if (r.code !== 0 && !out) {
      return { ok: false, platform: "windows", rows: [], error: r.stderr.trim() };
    }
    let parsed: unknown;
    try {
      parsed = out ? JSON.parse(out) : [];
    } catch (err) {
      return { ok: false, platform: "windows", rows: [], error: `parse error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const rows: DiskRow[] = arr.map((d: unknown) => {
      const o = d as Record<string, unknown>;
      return {
        name: String(o.Name ?? ""),
        mount: o.Root ? String(o.Root) : undefined,
        total_gb: bytesToGb(Number(o.Total ?? 0)),
        used_gb: bytesToGb(Number(o.Used ?? 0)),
        free_gb: bytesToGb(Number(o.Free ?? 0)),
        percent_used: Number(o.PercentUsed ?? 0),
      };
    });
    let filtered = rows;
    if (input.path) {
      const driveLetter = /^([A-Za-z]):/.exec(input.path)?.[1]?.toUpperCase();
      if (driveLetter) filtered = rows.filter((r) => r.name.toUpperCase() === driveLetter);
    }
    log(chalk.dim(`  ${filtered.length} drive${filtered.length === 1 ? "" : "s"}`));
    return { ok: true, platform: "windows", rows: filtered };
  }

  // Unix path
  const arg = input.path ?? "";
  const r = await spawnCapture("/bin/sh", ["-c", `df -kP ${arg} 2>/dev/null`]);
  const lines = (r.stdout || "").split("\n").filter((l) => l.trim().length > 0).slice(1);
  const rows: DiskRow[] = [];
  for (const l of lines) {
    const m = l.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    rows.push({
      name: m[1],
      filesystem: m[1],
      mount: m[6],
      total_gb: bytesToGb(Number(m[2]) * 1024),
      used_gb: bytesToGb(Number(m[3]) * 1024),
      free_gb: bytesToGb(Number(m[4]) * 1024),
      percent_used: Number(m[5]),
    });
  }
  log(chalk.dim(`  ${rows.length} mount${rows.length === 1 ? "" : "s"}`));
  return { ok: true, platform: process.platform, rows };
}

export const DISK_CHECK_TOOL_DEFINITION = {
  name: "disk_check",
  description:
    "Show disk usage for all filesystems (Windows: Get-PSDrive; Unix: df). Returns total/used/free in GB plus percent used. Pass an optional path to filter to that drive (Windows) or mount (Unix). Use this for 'is the disk full' / 'how much space left' instead of shelling out.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Optional path/drive (e.g. 'C:\\' on Windows, '/var' on Linux) to focus on." },
    },
    additionalProperties: false,
  },
};

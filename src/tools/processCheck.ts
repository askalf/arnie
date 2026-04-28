import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";

const TIMEOUT_MS = 15_000;
const MAX_ROWS = 200;

export interface ProcessCheckInput {
  name?: string;
  pid?: number;
  sort_by?: "cpu" | "memory" | "name";
  top?: number;
}

export interface ProcessRow {
  pid: number;
  name: string;
  cpu_seconds?: number;
  memory_mb?: number;
  user?: string;
  command?: string;
}

export interface ProcessCheckResult {
  ok: boolean;
  platform: string;
  rows: ProcessRow[];
  total: number;
  truncated: boolean;
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

export async function runProcessCheck(input: ProcessCheckInput): Promise<ProcessCheckResult> {
  log();
  log(chalk.cyan("ps ") + chalk.dim(`name=${input.name ?? "*"} pid=${input.pid ?? "*"} sort=${input.sort_by ?? "cpu"}`));

  const isWindows = process.platform === "win32";
  const top = Math.min(input.top ?? 50, MAX_ROWS);

  if (isWindows) {
    const filterParts: string[] = [];
    if (input.name) filterParts.push(`Where-Object { $_.ProcessName -like '${input.name.replace(/'/g, "''")}*' }`);
    if (input.pid !== undefined) filterParts.push(`Where-Object { $_.Id -eq ${input.pid} }`);
    const sortKey =
      input.sort_by === "memory"
        ? "WorkingSet64"
        : input.sort_by === "name"
          ? "ProcessName"
          : "CPU";
    const desc = input.sort_by === "name" ? "" : "-Descending";
    const ps = `Get-Process ${filterParts.length > 0 ? "| " + filterParts.join(" | ") + " " : ""}| Sort-Object ${sortKey} ${desc} | Select-Object -First ${top} Id, ProcessName, CPU, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, @{N='User';E={try { (Get-Process -Id $_.Id -IncludeUserName -ErrorAction Stop).UserName } catch { '' }}} | ConvertTo-Json -Compress`;
    const r = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const out = (r.stdout || "").trim();
    if (r.code !== 0 && !out) {
      return { ok: false, platform: "windows", rows: [], total: 0, truncated: false, error: r.stderr.trim() };
    }
    let parsed: unknown;
    try {
      parsed = out ? JSON.parse(out) : [];
    } catch (err) {
      return { ok: false, platform: "windows", rows: [], total: 0, truncated: false, error: `parse error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const rows: ProcessRow[] = arr.map((p: unknown) => {
      const o = p as Record<string, unknown>;
      return {
        pid: Number(o.Id ?? 0),
        name: String(o.ProcessName ?? ""),
        cpu_seconds: typeof o.CPU === "number" ? Math.round(o.CPU * 100) / 100 : undefined,
        memory_mb: typeof o.MemoryMB === "number" ? o.MemoryMB : undefined,
        user: o.User ? String(o.User) : undefined,
      };
    });
    log(chalk.dim(`  ${rows.length} processes`));
    return { ok: true, platform: "windows", rows, total: rows.length, truncated: rows.length === top };
  }

  // Unix path
  const sortKey = input.sort_by === "memory" ? "%mem" : input.sort_by === "name" ? "comm" : "%cpu";
  const sh = `ps -eo pid,user,%cpu,%mem,comm,args --sort=-${sortKey} 2>/dev/null | head -${top + 1}`;
  const r = await spawnCapture("/bin/sh", ["-c", sh]);
  const lines = (r.stdout || "").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, platform: process.platform, rows: [], total: 0, truncated: false, error: "no ps output" };
  }
  // First line is header
  const dataLines = lines.slice(1);
  let rows: ProcessRow[] = [];
  for (const l of dataLines) {
    const m = l.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      user: m[2],
      cpu_seconds: parseFloat(m[3]),
      memory_mb: parseFloat(m[4]),
      name: m[5],
      command: m[6],
    });
  }
  if (input.name) rows = rows.filter((r) => r.name.toLowerCase().includes(input.name!.toLowerCase()));
  if (input.pid !== undefined) rows = rows.filter((r) => r.pid === input.pid);

  log(chalk.dim(`  ${rows.length} processes`));
  return { ok: true, platform: process.platform, rows, total: rows.length, truncated: rows.length === top };
}

export const PROCESS_CHECK_TOOL_DEFINITION = {
  name: "process_check",
  description:
    "List running processes with PID, name, CPU, memory, and (Windows only) user. Optionally filter by name (prefix on Windows, substring on Linux) or pid. Sort by cpu (default), memory, or name. Returns top N rows (default 50, max 200). Use this for 'what's hogging CPU' / 'is X running' / 'find process by name' instead of shelling Get-Process or ps.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Optional process-name filter." },
      pid: { type: "integer", description: "Optional pid filter.", minimum: 1 },
      sort_by: { type: "string", enum: ["cpu", "memory", "name"], description: "Sort key (default cpu)." },
      top: { type: "integer", description: `Limit on rows returned (default 50, max ${MAX_ROWS}).`, minimum: 1, maximum: MAX_ROWS },
    },
    additionalProperties: false,
  },
};

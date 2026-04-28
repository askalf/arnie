import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";

const TIMEOUT_MS = 30_000;

export interface EventLogInput {
  source?: string;
  level?: "error" | "warning" | "info" | "all";
  max_entries?: number;
  since_minutes?: number;
}

export interface EventLogEntry {
  ts: string;
  source: string;
  level: string;
  event_id?: number;
  message: string;
}

export interface EventLogResult {
  ok: boolean;
  platform: string;
  entries: EventLogEntry[];
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

export async function runEventLog(input: EventLogInput): Promise<EventLogResult> {
  const max = Math.min(input.max_entries ?? 25, 100);
  const since = input.since_minutes ?? 60;
  const source = input.source ?? "System";
  const level = input.level ?? "error";

  log();
  log(chalk.cyan("event_log ") + chalk.dim(`source=${source} level=${level} since=${since}m max=${max}`));

  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Map level to Get-WinEvent Level numbers (1=Critical, 2=Error, 3=Warning, 4=Informational)
    const levelClause =
      level === "error"
        ? "Level=1,2"
        : level === "warning"
          ? "Level=3"
          : level === "info"
            ? "Level=4"
            : "";
    const sinceClause = `StartTime=(Get-Date).AddMinutes(-${since})`;
    const filterParts = [`LogName='${source.replace(/'/g, "''")}'`, sinceClause];
    if (levelClause) filterParts.push(levelClause);
    const filter = `@{ ${filterParts.join("; ")} }`;
    const ps = `try { Get-WinEvent -FilterHashtable ${filter} -MaxEvents ${max} -ErrorAction Stop | Select-Object @{N='ts';E={$_.TimeCreated.ToString('o')}}, @{N='source';E={$_.ProviderName}}, @{N='level';E={$_.LevelDisplayName}}, @{N='event_id';E={$_.Id}}, @{N='message';E={if ($_.Message) { $_.Message.Substring(0, [Math]::Min(500, $_.Message.Length)) } else { '' }}} | ConvertTo-Json -Compress } catch { if ($_.Exception.Message -match 'No events were found') { '[]' } else { Write-Error $_.Exception.Message } }`;
    const r = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const out = (r.stdout || "").trim();
    if (r.code !== 0 && !out) {
      return { ok: false, platform: "windows", entries: [], truncated: false, error: r.stderr.trim() };
    }
    let parsed: unknown;
    try {
      parsed = out ? JSON.parse(out) : [];
    } catch (err) {
      return { ok: false, platform: "windows", entries: [], truncated: false, error: `parse error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const entries: EventLogEntry[] = arr.map((e: unknown) => {
      const o = e as Record<string, unknown>;
      return {
        ts: String(o.ts ?? ""),
        source: String(o.source ?? ""),
        level: String(o.level ?? ""),
        event_id: typeof o.event_id === "number" ? o.event_id : undefined,
        message: String(o.message ?? "").trim(),
      };
    });
    log(chalk.dim(`  ${entries.length} event${entries.length === 1 ? "" : "s"}`));
    return { ok: true, platform: "windows", entries, truncated: entries.length === max };
  }

  // Linux journalctl
  if (process.platform === "linux") {
    const priority = level === "error" ? "0..3" : level === "warning" ? "4" : level === "info" ? "6" : "0..7";
    const sh = `journalctl -p ${priority} --since "${since} minutes ago" -n ${max} -o json --no-pager 2>/dev/null`;
    const r = await spawnCapture("/bin/sh", ["-c", sh]);
    const lines = (r.stdout || "").split("\n").filter((l) => l.trim().length > 0);
    const entries: EventLogEntry[] = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        entries.push({
          ts: typeof j["__REALTIME_TIMESTAMP"] === "string" ? new Date(Number(j["__REALTIME_TIMESTAMP"]) / 1000).toISOString() : "",
          source: String(j["_SYSTEMD_UNIT"] ?? j["SYSLOG_IDENTIFIER"] ?? ""),
          level: String(j["PRIORITY"] ?? ""),
          message: String(j["MESSAGE"] ?? "").slice(0, 500),
        });
      } catch {
        // skip bad lines
      }
    }
    log(chalk.dim(`  ${entries.length} event${entries.length === 1 ? "" : "s"}`));
    return { ok: true, platform: "linux", entries, truncated: entries.length === max };
  }

  return { ok: false, platform: process.platform, entries: [], truncated: false, error: `event_log not implemented for platform: ${process.platform}` };
}

export const EVENT_LOG_TOOL_DEFINITION = {
  name: "event_log",
  description:
    "Read recent system event log entries. Windows: Get-WinEvent against System/Application/Security logs (default System). Linux: journalctl. Filter by level (error|warning|info|all, default error), time window (since_minutes, default 60), and max_entries (default 25, max 100). Use this for 'what's wrong with the system' / 'recent errors' instead of digging through Event Viewer manually.",
  input_schema: {
    type: "object" as const,
    properties: {
      source: { type: "string", description: "Windows: log name (System|Application|Security|...). Linux: ignored." },
      level: { type: "string", enum: ["error", "warning", "info", "all"], description: "Severity filter (default error)." },
      max_entries: { type: "integer", description: "Max events to return (default 25, max 100).", minimum: 1, maximum: 100 },
      since_minutes: { type: "integer", description: "Time window in minutes (default 60).", minimum: 1 },
    },
    additionalProperties: false,
  },
};

import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";

const TIMEOUT_MS = 10_000;

const VALID_HIVES = new Set([
  "HKLM",
  "HKCU",
  "HKCR",
  "HKU",
  "HKCC",
  "HKEY_LOCAL_MACHINE",
  "HKEY_CURRENT_USER",
  "HKEY_CLASSES_ROOT",
  "HKEY_USERS",
  "HKEY_CURRENT_CONFIG",
]);

export interface RegistryReadInput {
  path: string;
  value?: string;
  recursive?: boolean;
}

export interface RegistryEntry {
  path: string;
  values: Record<string, string | number | boolean | null>;
  subkeys?: string[];
}

export interface RegistryReadResult {
  ok: boolean;
  platform: string;
  entries: RegistryEntry[];
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

export async function runRegistryRead(input: RegistryReadInput): Promise<RegistryReadResult> {
  log();
  log(chalk.cyan("registry ") + chalk.white(input.path) + chalk.dim(input.value ? ` value=${input.value}` : ""));

  if (process.platform !== "win32") {
    return { ok: false, platform: process.platform, entries: [], error: "registry_read is Windows-only" };
  }

  // Validate hive prefix to keep injection surface tight
  const firstSeg = input.path.split(/[\\:]/, 1)[0].toUpperCase();
  if (!VALID_HIVES.has(firstSeg)) {
    return {
      ok: false,
      platform: "win32",
      entries: [],
      error: `path must start with a valid hive (HKLM, HKCU, HKCR, HKU, HKCC); got "${firstSeg}"`,
    };
  }

  // Normalize HKLM\foo → HKLM:\foo for PowerShell PSDrive syntax
  let psPath = input.path;
  if (!/^HK[A-Z]+:/i.test(psPath) && !psPath.startsWith("HKEY_")) {
    psPath = psPath.replace(/^(HK[A-Z]+)\\/i, "$1:\\");
  }
  // Translate full HKEY_ names to PSDrive shortcuts
  psPath = psPath
    .replace(/^HKEY_LOCAL_MACHINE/i, "HKLM:")
    .replace(/^HKEY_CURRENT_USER/i, "HKCU:")
    .replace(/^HKEY_CLASSES_ROOT/i, "HKCR:")
    .replace(/^HKEY_USERS/i, "HKU:")
    .replace(/^HKEY_CURRENT_CONFIG/i, "HKCC:");

  const escaped = psPath.replace(/'/g, "''");
  let ps: string;
  if (input.value) {
    const val = input.value.replace(/'/g, "''");
    ps = `try { $v = Get-ItemPropertyValue -Path '${escaped}' -Name '${val}' -ErrorAction Stop; @{path='${escaped}'; values=@{ '${val}' = $v }} | ConvertTo-Json -Compress -Depth 4 } catch { Write-Error $_.Exception.Message }`;
  } else {
    const recursive = input.recursive ? "-Recurse" : "";
    ps = `try {
  $items = Get-ChildItem -Path '${escaped}' ${recursive} -ErrorAction Stop | Select-Object -First 50
  $self = Get-Item -Path '${escaped}' -ErrorAction SilentlyContinue
  $all = @()
  if ($self) { $all += $self }
  $all += $items
  $result = @()
  foreach ($it in $all) {
    $props = Get-ItemProperty -Path $it.PSPath -ErrorAction SilentlyContinue
    $values = @{}
    if ($props) {
      $props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object {
        $v = $_.Value
        if ($v -is [byte[]]) { $v = "<binary $($v.Length) bytes>" }
        elseif ($v -is [array]) { $v = $v -join ', ' }
        $values[$_.Name] = $v
      }
    }
    $subs = (Get-ChildItem -Path $it.PSPath -ErrorAction SilentlyContinue | Select-Object -First 50 | ForEach-Object { $_.PSChildName })
    $result += @{ path = $it.Name; values = $values; subkeys = $subs }
  }
  $result | ConvertTo-Json -Compress -Depth 4
} catch { Write-Error $_.Exception.Message }`;
  }

  const r = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  const out = (r.stdout || "").trim();
  if (r.code !== 0 && !out) {
    return { ok: false, platform: "win32", entries: [], error: r.stderr.trim() };
  }
  let parsed: unknown;
  try {
    parsed = out ? JSON.parse(out) : [];
  } catch (err) {
    return { ok: false, platform: "win32", entries: [], error: `parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const entries: RegistryEntry[] = arr.map((e: unknown) => {
    const o = e as Record<string, unknown>;
    const values: Record<string, string | number | boolean | null> = {};
    if (o.values && typeof o.values === "object") {
      for (const [k, v] of Object.entries(o.values as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
          values[k] = v;
        } else {
          values[k] = String(v);
        }
      }
    }
    return {
      path: String(o.path ?? ""),
      values,
      subkeys: Array.isArray(o.subkeys) ? (o.subkeys as string[]) : undefined,
    };
  });
  log(chalk.dim(`  ${entries.length} key${entries.length === 1 ? "" : "s"}`));
  return { ok: true, platform: "win32", entries };
}

export const REGISTRY_READ_TOOL_DEFINITION = {
  name: "registry_read",
  description:
    "Read Windows registry keys/values. Windows-only. Path must start with a recognized hive (HKLM, HKCU, HKCR, HKU, HKCC, or full HKEY_* names). Without 'value', returns the key's values plus its immediate subkeys (capped at 50). With 'value', returns just that value. With recursive=true, walks subkeys (also capped at 50). Use this for inspecting installed software, service config, autoruns, etc., instead of writing PowerShell from scratch.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Registry path, e.g. HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" },
      value: { type: "string", description: "If set, fetch only this value name. Otherwise list values + subkeys." },
      recursive: { type: "boolean", description: "Walk subkeys recursively (default false)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

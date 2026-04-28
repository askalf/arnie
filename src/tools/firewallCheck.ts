import { spawn } from "node:child_process";
import process from "node:process";
import chalk from "chalk";
import { log } from "../log.js";

const TIMEOUT_MS = 15_000;
const MAX_RULES = 200;

export interface FirewallCheckInput {
  rules?: boolean;
  name?: string;
  direction?: "inbound" | "outbound" | "all";
  enabled_only?: boolean;
}

export interface FirewallProfile {
  name: string;
  enabled: boolean;
  default_inbound?: string;
  default_outbound?: string;
}

export interface FirewallRule {
  name: string;
  direction: string;
  action: string;
  enabled: boolean;
  profile?: string;
}

export interface FirewallCheckResult {
  ok: boolean;
  platform: string;
  profiles: FirewallProfile[];
  rules?: FirewallRule[];
  truncated?: boolean;
  raw?: string;
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

async function commandExists(cmd: string): Promise<boolean> {
  const r = await spawnCapture("/bin/sh", ["-c", `command -v ${cmd} >/dev/null 2>&1 && echo yes || echo no`]);
  return r.stdout.trim() === "yes";
}

async function runWindows(input: FirewallCheckInput): Promise<FirewallCheckResult> {
  const profilePs =
    `Get-NetFirewallProfile | Select-Object Name, Enabled, ` +
    `@{N='DefaultInboundAction';E={$_.DefaultInboundAction.ToString()}}, ` +
    `@{N='DefaultOutboundAction';E={$_.DefaultOutboundAction.ToString()}} ` +
    `| ConvertTo-Json -Compress`;
  const pr = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", profilePs]);
  const pout = (pr.stdout || "").trim();
  if (pr.code !== 0 && !pout) {
    return { ok: false, platform: "windows", profiles: [], error: pr.stderr.trim() || "Get-NetFirewallProfile failed" };
  }
  let pParsed: unknown;
  try {
    pParsed = pout ? JSON.parse(pout) : [];
  } catch (err) {
    return {
      ok: false,
      platform: "windows",
      profiles: [],
      error: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const pArr = Array.isArray(pParsed) ? pParsed : [pParsed];
  const profiles: FirewallProfile[] = pArr.map((p: unknown) => {
    const o = p as Record<string, unknown>;
    return {
      name: String(o.Name ?? ""),
      enabled: o.Enabled === true || String(o.Enabled).toLowerCase() === "true",
      default_inbound: o.DefaultInboundAction ? String(o.DefaultInboundAction) : undefined,
      default_outbound: o.DefaultOutboundAction ? String(o.DefaultOutboundAction) : undefined,
    };
  });

  let rules: FirewallRule[] | undefined;
  let truncated = false;
  if (input.rules) {
    const filterParts: string[] = [];
    if (input.name) {
      filterParts.push(`Where-Object { $_.DisplayName -like '*${input.name.replace(/'/g, "''")}*' }`);
    }
    if (input.direction && input.direction !== "all") {
      const dir = input.direction === "inbound" ? "Inbound" : "Outbound";
      filterParts.push(`Where-Object { $_.Direction.ToString() -eq '${dir}' }`);
    }
    if (input.enabled_only) {
      filterParts.push(`Where-Object { $_.Enabled.ToString() -eq 'True' }`);
    }
    const filterClause = filterParts.length > 0 ? "| " + filterParts.join(" | ") : "";
    const ruleLimit = MAX_RULES + 1;
    const rulePs =
      `Get-NetFirewallRule ${filterClause} | Select-Object -First ${ruleLimit} ` +
      `@{N='Name';E={$_.DisplayName}}, ` +
      `@{N='Direction';E={$_.Direction.ToString()}}, ` +
      `@{N='Action';E={$_.Action.ToString()}}, ` +
      `@{N='Enabled';E={$_.Enabled.ToString()}}, ` +
      `@{N='Profile';E={$_.Profile.ToString()}} ` +
      `| ConvertTo-Json -Compress`;
    const rr = await spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", rulePs]);
    const rout = (rr.stdout || "").trim();
    if (rr.code === 0 || rout) {
      try {
        const parsed = rout ? JSON.parse(rout) : [];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        rules = arr.slice(0, MAX_RULES).map((s: unknown) => {
          const o = s as Record<string, unknown>;
          return {
            name: String(o.Name ?? ""),
            direction: String(o.Direction ?? ""),
            action: String(o.Action ?? ""),
            enabled: String(o.Enabled ?? "").toLowerCase() === "true",
            profile: o.Profile ? String(o.Profile) : undefined,
          };
        });
        truncated = arr.length > MAX_RULES;
      } catch {
        rules = [];
      }
    }
  }

  log(
    chalk.dim(
      `  ${profiles.map((p) => `${p.name}=${p.enabled ? "on" : "off"}`).join(" ")}` +
        (rules ? `, ${rules.length} rule${rules.length === 1 ? "" : "s"}` : ""),
    ),
  );
  return { ok: true, platform: "windows", profiles, rules, truncated };
}

async function runLinux(input: FirewallCheckInput): Promise<FirewallCheckResult> {
  // Try ufw → firewalld → iptables, in that order
  if (await commandExists("ufw")) {
    const r = await spawnCapture("/bin/sh", ["-c", "sudo -n ufw status verbose 2>/dev/null || ufw status verbose 2>/dev/null"]);
    const out = (r.stdout || r.stderr).trim();
    const enabled = /Status:\s+active/i.test(out);
    const profile: FirewallProfile = { name: "ufw", enabled };
    const defIn = out.match(/Default:\s+([^,]+)\s+\(incoming\)/i);
    const defOut = out.match(/,\s*([^,]+)\s+\(outgoing\)/i);
    if (defIn) profile.default_inbound = defIn[1].trim();
    if (defOut) profile.default_outbound = defOut[1].trim();

    let rules: FirewallRule[] | undefined;
    let truncated = false;
    if (input.rules) {
      const lines = out.split("\n").filter((l) => /\bALLOW\b|\bDENY\b|\bREJECT\b/i.test(l));
      const filtered = input.name ? lines.filter((l) => l.toLowerCase().includes(input.name!.toLowerCase())) : lines;
      const direction = input.direction ?? "all";
      const dirFiltered = filtered.filter((l) => {
        if (direction === "all") return true;
        const isIn = /\bIN\b/i.test(l);
        const isOut = /\bOUT\b/i.test(l);
        return direction === "inbound" ? isIn || (!isIn && !isOut) : isOut;
      });
      truncated = dirFiltered.length > MAX_RULES;
      rules = dirFiltered.slice(0, MAX_RULES).map((l) => {
        const action = /ALLOW/i.test(l) ? "Allow" : /DENY/i.test(l) ? "Block" : /REJECT/i.test(l) ? "Reject" : "";
        const dir = /\bOUT\b/i.test(l) ? "Outbound" : "Inbound";
        return { name: l.trim().slice(0, 200), direction: dir, action, enabled: true };
      });
    }
    log(chalk.dim(`  ufw=${enabled ? "on" : "off"}` + (rules ? `, ${rules.length} rule${rules.length === 1 ? "" : "s"}` : "")));
    return { ok: true, platform: "linux", profiles: [profile], rules, truncated, raw: out.slice(-1500) };
  }

  if (await commandExists("firewall-cmd")) {
    const stateR = await spawnCapture("/bin/sh", ["-c", "firewall-cmd --state 2>&1"]);
    const enabled = /running/i.test((stateR.stdout || stateR.stderr).trim());
    const profile: FirewallProfile = { name: "firewalld", enabled };
    let rules: FirewallRule[] | undefined;
    let raw = "";
    if (input.rules) {
      const r = await spawnCapture("/bin/sh", ["-c", "firewall-cmd --list-all 2>&1"]);
      raw = (r.stdout || r.stderr).trim();
      const services = raw.match(/services:\s*(.*)/)?.[1]?.trim().split(/\s+/) ?? [];
      rules = services.slice(0, MAX_RULES).map((s) => ({
        name: s,
        direction: "Inbound",
        action: "Allow",
        enabled: true,
      }));
      if (input.name) rules = rules.filter((r) => r.name.toLowerCase().includes(input.name!.toLowerCase()));
    }
    log(chalk.dim(`  firewalld=${enabled ? "on" : "off"}` + (rules ? `, ${rules.length} service${rules.length === 1 ? "" : "s"}` : "")));
    return { ok: true, platform: "linux", profiles: [profile], rules, raw: raw.slice(-1500) };
  }

  if (await commandExists("iptables")) {
    const r = await spawnCapture("/bin/sh", ["-c", "sudo -n iptables -L -n 2>/dev/null || iptables -L -n 2>/dev/null"]);
    const out = (r.stdout || r.stderr).trim();
    // iptables doesn't have a single "enabled" — presence of non-default rules suggests use
    const hasRules = /Chain\s+\w+.*\n.*\n\S/.test(out);
    const profile: FirewallProfile = { name: "iptables", enabled: hasRules };
    let rules: FirewallRule[] | undefined;
    if (input.rules) {
      const lines = out.split("\n").filter((l) => /^(ACCEPT|DROP|REJECT)/.test(l));
      const filtered = input.name ? lines.filter((l) => l.toLowerCase().includes(input.name!.toLowerCase())) : lines;
      rules = filtered.slice(0, MAX_RULES).map((l) => {
        const action = /^ACCEPT/.test(l) ? "Allow" : /^DROP/.test(l) ? "Block" : "Reject";
        return { name: l.trim().slice(0, 200), direction: "Inbound", action, enabled: true };
      });
    }
    log(chalk.dim(`  iptables ${hasRules ? "has rules" : "default"}` + (rules ? `, ${rules.length} rule${rules.length === 1 ? "" : "s"}` : "")));
    return { ok: true, platform: "linux", profiles: [profile], rules, raw: out.slice(-1500) };
  }

  return {
    ok: false,
    platform: "linux",
    profiles: [],
    error: "no supported firewall tool found (tried ufw, firewall-cmd, iptables)",
  };
}

async function runMac(input: FirewallCheckInput): Promise<FirewallCheckResult> {
  const path = "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const stateR = await spawnCapture("/bin/sh", ["-c", `${path} --getglobalstate 2>&1`]);
  const out = (stateR.stdout || stateR.stderr).trim();
  if (stateR.code !== 0 && !out) {
    return { ok: false, platform: "darwin", profiles: [], error: stateR.stderr.trim() || "socketfilterfw not available" };
  }
  const enabled = /enabled/i.test(out) && !/disabled/i.test(out);
  const profile: FirewallProfile = { name: "alf", enabled };

  let rules: FirewallRule[] | undefined;
  let raw = out;
  if (input.rules) {
    const r = await spawnCapture("/bin/sh", ["-c", `${path} --listapps 2>&1`]);
    raw = (r.stdout || r.stderr).trim();
    const matches = [...raw.matchAll(/^\s*\d+\s*:\s*(.+?)\s*\n\s*\(.*?(Allow|Block).*?\)/gm)];
    rules = matches.slice(0, MAX_RULES).map((m) => ({
      name: m[1].trim(),
      direction: "Inbound",
      action: m[2],
      enabled: true,
    }));
    if (input.name) rules = rules.filter((r) => r.name.toLowerCase().includes(input.name!.toLowerCase()));
  }
  log(chalk.dim(`  alf=${enabled ? "on" : "off"}` + (rules ? `, ${rules.length} app${rules.length === 1 ? "" : "s"}` : "")));
  return { ok: true, platform: "darwin", profiles: [profile], rules, raw: raw.slice(-1500) };
}

export async function runFirewallCheck(input: FirewallCheckInput): Promise<FirewallCheckResult> {
  log();
  log(
    chalk.cyan("firewall ") +
      chalk.dim(
        `rules=${input.rules ?? false} name=${input.name ?? "*"} dir=${input.direction ?? "all"}${input.enabled_only ? " enabled-only" : ""}`,
      ),
  );

  if (process.platform === "win32") return runWindows(input);
  if (process.platform === "linux") return runLinux(input);
  if (process.platform === "darwin") return runMac(input);
  return {
    ok: false,
    platform: process.platform,
    profiles: [],
    error: `firewall_check not implemented for platform: ${process.platform}`,
  };
}

export const FIREWALL_CHECK_TOOL_DEFINITION = {
  name: "firewall_check",
  description:
    "Inspect host firewall state. Windows: Get-NetFirewallProfile + optional Get-NetFirewallRule (Domain/Private/Public profiles, default actions, per-rule direction/action/enabled). Linux: ufw, then firewall-cmd, then iptables (whichever is present). macOS: socketfilterfw. By default returns just profile state — pass rules=true to also list rules (capped at 200). Use this for 'is the firewall on?', 'is there a rule blocking port 443?', 'what's blocking my outbound traffic?' instead of writing PowerShell/iptables manually.",
  input_schema: {
    type: "object" as const,
    properties: {
      rules: { type: "boolean", description: "Include the rule list. Default false (profile-only is much smaller)." },
      name: { type: "string", description: "Filter rules by display-name substring (case-insensitive)." },
      direction: { type: "string", enum: ["inbound", "outbound", "all"], description: "Filter rules by direction. Default all." },
      enabled_only: { type: "boolean", description: "Only return enabled rules. Default false." },
    },
    additionalProperties: false,
  },
};

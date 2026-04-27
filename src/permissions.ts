import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface PermissionRule {
  pattern: string;
  reason?: string;
}

export interface PermissionsConfig {
  allow: PermissionRule[];
  deny: PermissionRule[];
  source: string | null;
}

const EMPTY: PermissionsConfig = { allow: [], deny: [], source: null };

function compileRegexes(rules: PermissionRule[]): { rule: PermissionRule; re: RegExp }[] {
  const out: { rule: PermissionRule; re: RegExp }[] = [];
  for (const rule of rules) {
    try {
      out.push({ rule, re: new RegExp(rule.pattern) });
    } catch {
      // skip invalid regex; user gets a warning at load time
    }
  }
  return out;
}

export async function loadPermissions(): Promise<PermissionsConfig> {
  const candidates = [
    path.join(process.cwd(), ".arnie", "permissions.json"),
    path.join(os.homedir(), ".arnie", "permissions.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<PermissionsConfig>;
      return {
        allow: Array.isArray(parsed.allow) ? parsed.allow : [],
        deny: Array.isArray(parsed.deny) ? parsed.deny : [],
        source: file,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // rethrow unexpected errors so the user sees them
        throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return EMPTY;
}

export interface PermissionDecision {
  decision: "allow" | "deny" | "ask";
  reason?: string;
  rule?: string;
}

export function evaluateCommand(command: string, config: PermissionsConfig): PermissionDecision {
  const denyMatchers = compileRegexes(config.deny);
  for (const { rule, re } of denyMatchers) {
    if (re.test(command)) {
      return { decision: "deny", reason: rule.reason ?? "denied by permissions config", rule: rule.pattern };
    }
  }
  const allowMatchers = compileRegexes(config.allow);
  for (const { rule, re } of allowMatchers) {
    if (re.test(command)) {
      return { decision: "allow", reason: rule.reason ?? "allowed by permissions config", rule: rule.pattern };
    }
  }
  return { decision: "ask" };
}

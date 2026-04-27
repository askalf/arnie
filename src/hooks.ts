import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import chalk from "chalk";

export interface HookConfig {
  before_tool?: string[];
  after_tool?: string[];
  on_error?: string[];
  source: string | null;
}

interface ToolEvent {
  name: string;
  input: unknown;
  result?: string;
  error?: string;
}

const EMPTY: HookConfig = { source: null };

export async function loadHooks(): Promise<HookConfig> {
  const candidates = [
    path.join(process.cwd(), ".arnie", "hooks.json"),
    path.join(os.homedir(), ".arnie", "hooks.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<HookConfig>;
      return {
        before_tool: Array.isArray(parsed.before_tool) ? parsed.before_tool : undefined,
        after_tool: Array.isArray(parsed.after_tool) ? parsed.after_tool : undefined,
        on_error: Array.isArray(parsed.on_error) ? parsed.on_error : undefined,
        source: file,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return EMPTY;
}

let active: HookConfig = EMPTY;

export function setHooks(cfg: HookConfig): void {
  active = cfg;
}

function buildEnv(event: ToolEvent): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARNIE_TOOL_NAME: event.name,
    ARNIE_TOOL_INPUT: JSON.stringify(event.input).slice(0, 4000),
    ARNIE_TOOL_RESULT: event.result ? event.result.slice(0, 4000) : "",
    ARNIE_TOOL_ERROR: event.error ?? "",
  };
}

function runHookCommand(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "powershell.exe" : "/bin/sh";
    const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
    const child = spawn(cmd, args, { env, stdio: "ignore" });
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 5000);
    child.on("error", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve();
    });
    child.on("close", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runHooks(commands: string[] | undefined, event: ToolEvent): Promise<void> {
  if (!commands || commands.length === 0) return;
  const env = buildEnv(event);
  await Promise.all(commands.map((c) => runHookCommand(c, env)));
}

export async function fireBeforeTool(name: string, input: unknown): Promise<void> {
  await runHooks(active.before_tool, { name, input });
}

export async function fireAfterTool(name: string, input: unknown, result: string): Promise<void> {
  await runHooks(active.after_tool, { name, input, result });
}

export async function fireOnError(name: string, input: unknown, error: string): Promise<void> {
  await runHooks(active.on_error, { name, input, error });
}

export function describeHooks(): string {
  if (!active.source) return "no hooks loaded";
  const parts: string[] = [];
  if (active.before_tool) parts.push(`before_tool x${active.before_tool.length}`);
  if (active.after_tool) parts.push(`after_tool x${active.after_tool.length}`);
  if (active.on_error) parts.push(`on_error x${active.on_error.length}`);
  return `${chalk.dim(active.source)} (${parts.join(", ") || "none"})`;
}

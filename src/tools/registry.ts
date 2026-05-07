import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { fireBeforeTool, fireAfterTool, fireOnError } from "../hooks.js";
import { recordToolCall } from "../toolStats.js";
import { isDryRun, isMutatingTool, dryRunRefusal } from "../dryRun.js";

import { SHELL_TOOL_DEFINITION, runShell } from "./shell.js";
import { READ_FILE_TOOL_DEFINITION, runReadFile } from "./readFile.js";
import { LIST_DIR_TOOL_DEFINITION, runListDir } from "./listDir.js";
import { WRITE_FILE_TOOL_DEFINITION, runWriteFile } from "./writeFile.js";
import { EDIT_FILE_TOOL_DEFINITION, runEditFile } from "./editFile.js";
import { GREP_TOOL_DEFINITION, runGrep } from "./grep.js";
import {
  SHELL_BG_TOOL_DEFINITION,
  SHELL_STATUS_TOOL_DEFINITION,
  SHELL_KILL_TOOL_DEFINITION,
  runShellBackground,
  runShellStatus,
  runShellKill,
} from "./backgroundShell.js";
import {
  NETWORK_CHECK_TOOL_DEFINITION,
  SERVICE_CHECK_TOOL_DEFINITION,
  runNetworkCheck,
  runServiceCheck,
} from "./netCheck.js";
import { SUBAGENT_TOOL_DEFINITION, runSubagent } from "./subagent.js";
import { TAIL_LOG_TOOL_DEFINITION, runTailLog } from "./tailLog.js";
import { PROCESS_CHECK_TOOL_DEFINITION, runProcessCheck } from "./processCheck.js";
import { DISK_CHECK_TOOL_DEFINITION, runDiskCheck } from "./diskCheck.js";
import { APPLY_PATCH_TOOL_DEFINITION, runApplyPatch } from "./applyPatch.js";
import { MONITOR_TOOL_DEFINITION, runMonitor } from "./monitor.js";
import { EVENT_LOG_TOOL_DEFINITION, runEventLog } from "./eventLog.js";
import { REGISTRY_READ_TOOL_DEFINITION, runRegistryRead } from "./registryRead.js";
import { FIREWALL_CHECK_TOOL_DEFINITION, runFirewallCheck } from "./firewallCheck.js";
import {
  SSH_EXEC_TOOL_DEFINITION,
  SCP_GET_TOOL_DEFINITION,
  SSH_HOSTS_TOOL_DEFINITION,
  runSshExec,
  runScpGet,
  runSshHosts,
} from "./ssh.js";

const shellSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(1).max(300).optional(),
  reason: z.string().optional(),
});

const readFileSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

const listDirSchema = z.object({
  path: z.string().min(1),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(["overwrite", "create_only"]).optional(),
  reason: z.string().optional(),
});

const editFileSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
  reason: z.string().optional(),
});

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).optional(),
  context: z.number().int().min(0).max(5).optional(),
  glob: z.string().optional(),
  literal: z.boolean().optional(),
});

const shellBgSchema = z.object({
  command: z.string().min(1),
  reason: z.string().optional(),
});

const shellStatusSchema = z.object({
  job_id: z.string().min(1),
  output_max_chars: z.number().int().min(100).optional(),
});

const shellKillSchema = z.object({
  job_id: z.string().min(1),
});

const networkCheckSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  ping: z.boolean().optional(),
});

const serviceCheckSchema = z.object({
  name: z.string().optional(),
  filter: z.enum(["running", "stopped", "all"]).optional(),
});

const subagentSchema = z.object({
  task: z.string().min(1),
  model: z.string().optional(),
});

const tailLogSchema = z.object({
  path: z.string().min(1),
  lines: z.number().int().min(1).max(5000).optional(),
  filter: z.string().optional(),
  case_insensitive: z.boolean().optional(),
});

const processCheckSchema = z.object({
  name: z.string().optional(),
  pid: z.number().int().min(1).optional(),
  sort_by: z.enum(["cpu", "memory", "name"]).optional(),
  top: z.number().int().min(1).max(200).optional(),
});

const diskCheckSchema = z.object({
  path: z.string().optional(),
});

const applyPatchSchema = z.object({
  path: z.string().min(1),
  patch: z.string().min(1),
  reason: z.string().optional(),
});

const monitorSchema = z.object({
  command: z.string().min(1),
  iterations: z.number().int().min(1).max(30).optional(),
  interval_seconds: z.number().int().min(1).max(60).optional(),
  reason: z.string().optional(),
});

const eventLogSchema = z.object({
  source: z.string().optional(),
  level: z.enum(["error", "warning", "info", "all"]).optional(),
  max_entries: z.number().int().min(1).max(100).optional(),
  since_minutes: z.number().int().min(1).optional(),
});

const registryReadSchema = z.object({
  path: z.string().min(1),
  value: z.string().optional(),
  recursive: z.boolean().optional(),
});

const firewallCheckSchema = z.object({
  rules: z.boolean().optional(),
  name: z.string().optional(),
  direction: z.enum(["inbound", "outbound", "all"]).optional(),
  enabled_only: z.boolean().optional(),
});

const sshExecSchema = z.object({
  host: z.string().min(1),
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(1).max(300).optional(),
  reason: z.string().optional(),
});

const scpGetSchema = z.object({
  host: z.string().min(1),
  remote_path: z.string().min(1),
  local_path: z.string().optional(),
});

const sshHostsSchema = z.object({});

interface ToolHandler {
  schema: z.ZodTypeAny;
  run: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  client: import("@anthropic-ai/sdk").default;
}

const HANDLERS: Record<string, ToolHandler> = {
  shell: { schema: shellSchema, run: (i) => runShell(i as z.infer<typeof shellSchema>) },
  read_file: { schema: readFileSchema, run: (i) => runReadFile(i as z.infer<typeof readFileSchema>) },
  list_dir: { schema: listDirSchema, run: (i) => runListDir(i as z.infer<typeof listDirSchema>) },
  write_file: { schema: writeFileSchema, run: (i) => runWriteFile(i as z.infer<typeof writeFileSchema>) },
  edit_file: { schema: editFileSchema, run: (i) => runEditFile(i as z.infer<typeof editFileSchema>) },
  grep: { schema: grepSchema, run: (i) => runGrep(i as z.infer<typeof grepSchema>) },
  shell_background: { schema: shellBgSchema, run: (i) => runShellBackground(i as z.infer<typeof shellBgSchema>) },
  shell_status: { schema: shellStatusSchema, run: (i) => runShellStatus(i as z.infer<typeof shellStatusSchema>) },
  shell_kill: { schema: shellKillSchema, run: (i) => runShellKill(i as z.infer<typeof shellKillSchema>) },
  network_check: { schema: networkCheckSchema, run: (i) => runNetworkCheck(i as z.infer<typeof networkCheckSchema>) },
  service_check: { schema: serviceCheckSchema, run: (i) => runServiceCheck(i as z.infer<typeof serviceCheckSchema>) },
  subagent: {
    schema: subagentSchema,
    run: (i, ctx) => runSubagent(i as z.infer<typeof subagentSchema>, ctx.client),
  },
  tail_log: { schema: tailLogSchema, run: (i) => runTailLog(i as z.infer<typeof tailLogSchema>) },
  process_check: { schema: processCheckSchema, run: (i) => runProcessCheck(i as z.infer<typeof processCheckSchema>) },
  disk_check: { schema: diskCheckSchema, run: (i) => runDiskCheck(i as z.infer<typeof diskCheckSchema>) },
  apply_patch: { schema: applyPatchSchema, run: (i) => runApplyPatch(i as z.infer<typeof applyPatchSchema>) },
  monitor: { schema: monitorSchema, run: (i) => runMonitor(i as z.infer<typeof monitorSchema>) },
  event_log: { schema: eventLogSchema, run: (i) => runEventLog(i as z.infer<typeof eventLogSchema>) },
  registry_read: { schema: registryReadSchema, run: (i) => runRegistryRead(i as z.infer<typeof registryReadSchema>) },
  firewall_check: { schema: firewallCheckSchema, run: (i) => runFirewallCheck(i as z.infer<typeof firewallCheckSchema>) },
  ssh_exec: { schema: sshExecSchema, run: (i) => runSshExec(i as z.infer<typeof sshExecSchema>) },
  scp_get: { schema: scpGetSchema, run: (i) => runScpGet(i as z.infer<typeof scpGetSchema>) },
  ssh_hosts: { schema: sshHostsSchema, run: (i) => runSshHosts(i as z.infer<typeof sshHostsSchema>) },
};

export interface ToolDispatchOptions {
  webSearch: boolean;
  subagent: boolean;
}

export function buildToolList(opts: ToolDispatchOptions): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [
    SHELL_TOOL_DEFINITION,
    READ_FILE_TOOL_DEFINITION,
    LIST_DIR_TOOL_DEFINITION,
    WRITE_FILE_TOOL_DEFINITION,
    EDIT_FILE_TOOL_DEFINITION,
    GREP_TOOL_DEFINITION,
    SHELL_BG_TOOL_DEFINITION,
    SHELL_STATUS_TOOL_DEFINITION,
    SHELL_KILL_TOOL_DEFINITION,
    NETWORK_CHECK_TOOL_DEFINITION,
    SERVICE_CHECK_TOOL_DEFINITION,
    TAIL_LOG_TOOL_DEFINITION,
    PROCESS_CHECK_TOOL_DEFINITION,
    DISK_CHECK_TOOL_DEFINITION,
    APPLY_PATCH_TOOL_DEFINITION,
    MONITOR_TOOL_DEFINITION,
    EVENT_LOG_TOOL_DEFINITION,
    REGISTRY_READ_TOOL_DEFINITION,
    FIREWALL_CHECK_TOOL_DEFINITION,
    SSH_EXEC_TOOL_DEFINITION,
    SCP_GET_TOOL_DEFINITION,
    SSH_HOSTS_TOOL_DEFINITION,
  ];
  if (opts.subagent) {
    tools.push(SUBAGENT_TOOL_DEFINITION);
  }
  if (opts.webSearch) {
    tools.push({ type: "web_search_20260209", name: "web_search" });
  }
  return tools;
}

const PARALLEL_SAFE = new Set([
  "read_file",
  "list_dir",
  "grep",
  "network_check",
  "service_check",
  "shell_status",
  "subagent",
  "tail_log",
  "process_check",
  "disk_check",
  "event_log",
  "registry_read",
  "firewall_check",
  "ssh_hosts",
]);

export function isParallelSafe(name: string): boolean {
  return PARALLEL_SAFE.has(name);
}

export async function dispatchTool(name: string, input: unknown, ctx: ToolContext): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    const errMsg = `unknown tool: ${name}`;
    await fireOnError(name, input, errMsg).catch(() => {});
    return JSON.stringify({ ok: false, error: errMsg });
  }
  const parsed = handler.schema.safeParse(input);
  if (!parsed.success) {
    const errMsg = `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
    await fireOnError(name, input, errMsg).catch(() => {});
    return JSON.stringify({ ok: false, error: errMsg });
  }
  if (isDryRun() && isMutatingTool(name)) {
    return dryRunRefusal(name, parsed.data);
  }
  await fireBeforeTool(name, parsed.data).catch(() => {});
  const start = Date.now();
  try {
    const result = await handler.run(parsed.data, ctx);
    const resultStr = JSON.stringify(result);
    const elapsed = Date.now() - start;
    const ok = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
    recordToolCall(name, elapsed, ok);
    await fireAfterTool(name, parsed.data, resultStr).catch(() => {});
    return resultStr;
  } catch (err) {
    const elapsed = Date.now() - start;
    recordToolCall(name, elapsed, false);
    const msg = err instanceof Error ? err.message : String(err);
    await fireOnError(name, parsed.data, msg).catch(() => {});
    return JSON.stringify({ ok: false, error: `tool execution failed: ${msg}` });
  }
}

export function toolNames(): string[] {
  return Object.keys(HANDLERS);
}

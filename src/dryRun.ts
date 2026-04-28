let dryRun = false;

const MUTATING_TOOLS = new Set([
  "shell",
  "shell_background",
  "shell_kill",
  "write_file",
  "edit_file",
  "apply_patch",
  "monitor",
]);

export function setDryRun(value: boolean): void {
  dryRun = value;
}

export function isDryRun(): boolean {
  return dryRun;
}

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

export function dryRunRefusal(toolName: string, input: unknown): string {
  return JSON.stringify({
    ok: false,
    cancelled: true,
    error: `dry-run mode: refused to run '${toolName}'. Investigation tools (read_file, list_dir, grep, network_check, service_check, tail_log, process_check, disk_check, shell_status, web_search, subagent) are still available. Tell the user what you would have done with: ${JSON.stringify(input).slice(0, 500)}`,
  });
}

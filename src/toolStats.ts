import chalk from "chalk";

interface ToolStat {
  count: number;
  totalMs: number;
  errors: number;
}

const stats = new Map<string, ToolStat>();

export function recordToolCall(name: string, ms: number, ok: boolean): void {
  let s = stats.get(name);
  if (!s) {
    s = { count: 0, totalMs: 0, errors: 0 };
    stats.set(name, s);
  }
  s.count += 1;
  s.totalMs += ms;
  if (!ok) s.errors += 1;
}

export function resetToolStats(): void {
  stats.clear();
}

export function formatToolStats(): string {
  if (stats.size === 0) return chalk.dim("no tool calls yet");
  const rows = [...stats.entries()].sort((a, b) => b[1].count - a[1].count);
  const lines = [chalk.bold("tool stats:")];
  for (const [name, s] of rows) {
    const avg = s.count > 0 ? Math.round(s.totalMs / s.count) : 0;
    const errPart = s.errors > 0 ? chalk.red(` errors=${s.errors}`) : "";
    lines.push(`  ${chalk.white(name.padEnd(18))} calls=${String(s.count).padStart(3)}  avg=${String(avg).padStart(5)}ms  total=${s.totalMs}ms${errPart}`);
  }
  return lines.join("\n");
}

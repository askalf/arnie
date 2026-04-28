import path from "node:path";
import chalk from "chalk";
import type { UsageTotals } from "./usage.js";
import { listJobs } from "./tools/backgroundShell.js";
import { isDryRun } from "./dryRun.js";

export interface StatusContext {
  model: string;
  effort: string;
  cwd: string;
  totals: UsageTotals;
  planMode: boolean;
}

export function renderStatusLine(ctx: StatusContext): string {
  const parts: string[] = [];

  parts.push(chalk.cyan(ctx.model));
  parts.push(chalk.dim(`effort=${ctx.effort}`));
  parts.push(chalk.yellow(`$${ctx.totals.costUsd.toFixed(4)}`));
  parts.push(chalk.dim(`turns=${ctx.totals.turns}`));

  const jobs = listJobs();
  const running = jobs.filter((j) => j.state === "running").length;
  if (running > 0) {
    parts.push(chalk.green(`jobs=${running}`));
  }

  parts.push(chalk.dim(`cwd=${path.basename(ctx.cwd) || ctx.cwd}`));

  if (ctx.planMode) {
    parts.push(chalk.magenta("[plan]"));
  }
  if (isDryRun()) {
    parts.push(chalk.magenta("[dry-run]"));
  }

  return parts.join(chalk.dim(" · "));
}

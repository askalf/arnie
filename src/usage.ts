import chalk from "chalk";
import type Anthropic from "@anthropic-ai/sdk";

const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number; cacheWrite5m: number; cacheRead: number }> = {
  "claude-opus-4-7": { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite5m: 1.25, cacheRead: 0.1 },
};

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

export function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

export function turnCost(model: string, usage: Anthropic.Usage): number {
  const p = PRICING_PER_M_TOKENS[model];
  if (!p) return 0;
  const M = 1_000_000;
  return (
    (usage.input_tokens * p.input) / M +
    (usage.output_tokens * p.output) / M +
    ((usage.cache_creation_input_tokens ?? 0) * p.cacheWrite5m) / M +
    ((usage.cache_read_input_tokens ?? 0) * p.cacheRead) / M
  );
}

export function accumulate(totals: UsageTotals, model: string, usage: Anthropic.Usage): void {
  totals.inputTokens += usage.input_tokens;
  totals.outputTokens += usage.output_tokens;
  totals.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  totals.costUsd += turnCost(model, usage);
  totals.turns += 1;
}

export function formatTurnUsage(model: string, usage: Anthropic.Usage): string {
  const cost = turnCost(model, usage);
  const parts = [
    `in=${usage.input_tokens}`,
    `out=${usage.output_tokens}`,
  ];
  if (usage.cache_creation_input_tokens) parts.push(`cache_w=${usage.cache_creation_input_tokens}`);
  if (usage.cache_read_input_tokens) parts.push(`cache_r=${usage.cache_read_input_tokens}`);
  parts.push(`$${cost.toFixed(4)}`);
  return chalk.dim(`[${parts.join(" ")}]`);
}

export function formatSessionTotals(totals: UsageTotals): string {
  const lines = [
    chalk.bold("session usage:"),
    `  turns:           ${totals.turns}`,
    `  input tokens:    ${totals.inputTokens.toLocaleString()}`,
    `  output tokens:   ${totals.outputTokens.toLocaleString()}`,
    `  cache writes:    ${totals.cacheCreationTokens.toLocaleString()}`,
    `  cache reads:     ${totals.cacheReadTokens.toLocaleString()}`,
    `  estimated cost:  ${chalk.yellow(`$${totals.costUsd.toFixed(4)}`)}`,
  ];
  return lines.join("\n");
}

export function deltaTotals(curr: UsageTotals, baseline: UsageTotals): UsageTotals {
  return {
    inputTokens: curr.inputTokens - baseline.inputTokens,
    outputTokens: curr.outputTokens - baseline.outputTokens,
    cacheCreationTokens: curr.cacheCreationTokens - baseline.cacheCreationTokens,
    cacheReadTokens: curr.cacheReadTokens - baseline.cacheReadTokens,
    costUsd: curr.costUsd - baseline.costUsd,
    turns: curr.turns - baseline.turns,
  };
}

export function snapshotTotals(t: UsageTotals): UsageTotals {
  return { ...t };
}

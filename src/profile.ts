import type Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";

export async function describeModel(client: Anthropic, modelId: string): Promise<string> {
  let m;
  try {
    m = await client.models.retrieve(modelId);
  } catch (err) {
    return chalk.red(`failed to fetch model info for ${modelId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lines: string[] = [];
  lines.push(chalk.bold(`${m.display_name} (${m.id})`));
  lines.push(`  ${chalk.dim("type:")}            ${m.type}`);
  lines.push(`  ${chalk.dim("created:")}         ${m.created_at}`);
  if ("max_input_tokens" in m && typeof (m as { max_input_tokens?: number }).max_input_tokens === "number") {
    lines.push(`  ${chalk.dim("context:")}         ${(m as { max_input_tokens: number }).max_input_tokens.toLocaleString()} tokens`);
  }
  if ("max_tokens" in m && typeof (m as { max_tokens?: number }).max_tokens === "number") {
    lines.push(`  ${chalk.dim("max output:")}      ${(m as { max_tokens: number }).max_tokens.toLocaleString()} tokens`);
  }
  const caps = (m as unknown as { capabilities?: Record<string, unknown> }).capabilities;
  if (caps && typeof caps === "object") {
    const supported = (path: string[]): boolean => {
      let cur: unknown = caps;
      for (const p of path) {
        if (typeof cur !== "object" || cur === null) return false;
        cur = (cur as Record<string, unknown>)[p];
      }
      return typeof cur === "object" && cur !== null && (cur as { supported?: boolean }).supported === true;
    };
    const features: string[] = [];
    if (supported(["image_input"])) features.push("vision");
    if (supported(["thinking", "types", "adaptive"])) features.push("adaptive thinking");
    if (supported(["thinking", "types", "enabled"])) features.push("manual thinking");
    if (supported(["effort"])) {
      const levels = ["low", "medium", "high", "xhigh", "max"].filter((l) => supported(["effort", l]));
      if (levels.length > 0) features.push(`effort=[${levels.join(",")}]`);
    }
    if (supported(["structured_outputs"])) features.push("structured outputs");
    if (supported(["context_management", "compact_20260112"])) features.push("compaction");
    if (features.length > 0) {
      lines.push(`  ${chalk.dim("features:")}        ${features.join(", ")}`);
    }
  }
  return lines.join("\n");
}

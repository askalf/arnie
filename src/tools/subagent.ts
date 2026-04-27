import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";

import { READ_FILE_TOOL_DEFINITION, runReadFile, type ReadFileInput } from "./readFile.js";
import { LIST_DIR_TOOL_DEFINITION, runListDir, type ListDirInput } from "./listDir.js";
import { GREP_TOOL_DEFINITION, runGrep, type GrepInput } from "./grep.js";

const SUB_TOOLS: Anthropic.ToolUnion[] = [READ_FILE_TOOL_DEFINITION, LIST_DIR_TOOL_DEFINITION, GREP_TOOL_DEFINITION];

const SUB_SYSTEM = `You are a focused investigation subagent spawned by the main Arnie companion. Your job is a single, well-defined exploration: read files, list directories, grep for patterns, and report findings concisely.

Constraints:
- Read-only tools only (read_file, list_dir, grep). You do NOT have shell access. You CANNOT modify the filesystem, run commands, or call the network.
- Stay focused on the assigned task. Don't expand scope.
- When you've gathered enough information to answer the task, return a tight summary — facts and file paths, not commentary. The main agent will integrate your findings.
- Cite the specific files and line numbers that support your findings.
- If the task is impossible with read-only tools, say so explicitly and explain what would be needed.`;

const MAX_TURNS = 8;
const SUB_MAX_TOKENS = 4000;

async function dispatchSubTool(name: string, input: unknown): Promise<string> {
  try {
    if (name === "read_file") return JSON.stringify(await runReadFile(input as ReadFileInput));
    if (name === "list_dir") return JSON.stringify(await runListDir(input as ListDirInput));
    if (name === "grep") return JSON.stringify(await runGrep(input as GrepInput));
    return JSON.stringify({ ok: false, error: `subagent tool not allowed: ${name}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: msg });
  }
}

export interface SubagentInput {
  task: string;
  model?: string;
}

export interface SubagentResult {
  ok: boolean;
  task: string;
  model: string;
  summary: string;
  turns: number;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  error?: string;
}

export async function runSubagent(input: SubagentInput, client: Anthropic): Promise<SubagentResult> {
  const model = input.model ?? "claude-haiku-4-5";
  console.log();
  console.log(chalk.cyan("subagent ") + chalk.dim(`(${model}) — `) + chalk.white(input.task.slice(0, 80) + (input.task.length > 80 ? "…" : "")));

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Task:\n${input.task}\n\nWhen you have gathered enough information, respond with a concise summary of findings. Do not call any more tools after that.`,
    },
  ];

  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let summary = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create({
        model,
        max_tokens: SUB_MAX_TOKENS,
        system: [{ type: "text", text: SUB_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages,
        tools: SUB_TOOLS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        task: input.task,
        model,
        summary,
        turns: turn,
        usage,
        error: `subagent api error: ${msg}`,
      };
    }

    usage.input += resp.usage.input_tokens;
    usage.output += resp.usage.output_tokens;
    usage.cache_read += resp.usage.cache_read_input_tokens ?? 0;
    usage.cache_write += resp.usage.cache_creation_input_tokens ?? 0;

    messages.push({ role: "assistant", content: resp.content });

    const textParts = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text);
    if (textParts.length > 0) summary = textParts.join("\n").trim();

    if (resp.stop_reason !== "tool_use") {
      console.log(chalk.dim(`  done in ${turn + 1} turn${turn === 0 ? "" : "s"}, ${usage.input + usage.output} tokens`));
      return { ok: true, task: input.task, model, summary, turns: turn + 1, usage };
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const result = await dispatchSubTool(t.name, t.input);
      toolResults.push({ type: "tool_result", tool_use_id: t.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  console.log(chalk.yellow(`  hit max turns (${MAX_TURNS})`));
  return {
    ok: true,
    task: input.task,
    model,
    summary: summary || "(subagent hit max turns without producing a final summary)",
    turns: MAX_TURNS,
    usage,
  };
}

export const SUBAGENT_TOOL_DEFINITION = {
  name: "subagent",
  description:
    "Spawn a focused subagent to do a read-only investigation in parallel — file reads, directory listings, grep searches. Runs on a cheaper/faster model (default claude-haiku-4-5) and returns a concise summary. Use for: enumerating things across many files, finding all references to a pattern, summarizing a large log, mapping out a directory structure. The subagent has NO shell access and cannot modify anything. Provide a single, narrow task description; the subagent will not be a generalist for you.",
  input_schema: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description: "The task to investigate. Be specific about what to look for and what to return.",
      },
      model: {
        type: "string",
        description: "Override model (default claude-haiku-4-5).",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
};

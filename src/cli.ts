#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import process from "node:process";

import { buildSystemBlocks } from "./systemPrompt.js";
import { SHELL_TOOL_DEFINITION, runShell, type ShellInput } from "./tools/shell.js";
import { READ_FILE_TOOL_DEFINITION, runReadFile, type ReadFileInput } from "./tools/readFile.js";
import { prompt } from "./confirm.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 16000;

const TOOLS: Anthropic.ToolUnion[] = [SHELL_TOOL_DEFINITION, READ_FILE_TOOL_DEFINITION];

const BANNER = `${chalk.bold.cyan("arnie")} ${chalk.dim("— portable IT troubleshooting assistant")}
${chalk.dim("type")} ${chalk.white("/help")} ${chalk.dim("for commands,")} ${chalk.white("/exit")} ${chalk.dim("to quit")}
`;

const HELP = `${chalk.bold("Commands:")}
  ${chalk.white("/help")}    show this help
  ${chalk.white("/clear")}   reset the conversation
  ${chalk.white("/exit")}    quit (or Ctrl+C twice)
${chalk.bold("Tools available to the model:")}
  ${chalk.white("shell")}     run a shell command (destructive ops require confirmation)
  ${chalk.white("read_file")} read a file from disk
`;

async function executeTool(name: string, input: unknown): Promise<string> {
  if (name === "shell") {
    const result = await runShell(input as ShellInput);
    return JSON.stringify(result);
  }
  if (name === "read_file") {
    const result = await runReadFile(input as ReadFileInput);
    return JSON.stringify(result);
  }
  return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
}

async function runTurn(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  systemBlocks: Anthropic.TextBlockParam[],
): Promise<Anthropic.MessageParam[]> {
  while (true) {
    process.stdout.write(chalk.dim("arnie: "));

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: systemBlocks,
      messages,
      tools: TOOLS,
      cache_control: { type: "ephemeral" },
    });

    stream.on("text", (delta) => {
      process.stdout.write(delta);
    });

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      process.stdout.write("\n");
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`error: ${msg}`));
      return messages;
    }

    process.stdout.write("\n");

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") {
      return messages;
    }

    if (message.stop_reason === "max_tokens") {
      console.log(chalk.yellow("\n[hit max_tokens — response was cut off]"));
      return messages;
    }

    if (message.stop_reason === "refusal") {
      console.log(chalk.yellow("\n[response was refused]"));
      return messages;
    }

    if (message.stop_reason === "pause_turn") {
      continue;
    }

    if (message.stop_reason !== "tool_use") {
      console.log(chalk.yellow(`\n[unexpected stop_reason: ${message.stop_reason}]`));
      return messages;
    }

    const toolUseBlocks = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUseBlocks) {
      const result = await executeTool(tool.name, tool.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

function handleSlashCommand(line: string, messages: Anthropic.MessageParam[]): "exit" | "continue" | null {
  const cmd = line.trim().toLowerCase();
  if (cmd === "/exit" || cmd === "/quit") return "exit";
  if (cmd === "/help" || cmd === "/?") {
    console.log(HELP);
    return "continue";
  }
  if (cmd === "/clear") {
    messages.length = 0;
    console.log(chalk.dim("conversation cleared"));
    return "continue";
  }
  return null;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red("error: ANTHROPIC_API_KEY is not set"));
    console.error(chalk.dim("get a key at https://console.anthropic.com and set it in your environment"));
    process.exit(1);
  }

  const client = new Anthropic();
  const systemBlocks = buildSystemBlocks();
  const messages: Anthropic.MessageParam[] = [];

  process.stdout.write(BANNER + "\n");

  let sigintCount = 0;
  process.on("SIGINT", () => {
    sigintCount += 1;
    if (sigintCount >= 2) {
      console.log("\n" + chalk.dim("bye"));
      process.exit(0);
    }
    console.log("\n" + chalk.dim("(press Ctrl+C again to exit)"));
  });

  while (true) {
    sigintCount = 0;
    let line: string;
    try {
      line = await prompt(chalk.bold.green("you> "));
    } catch {
      break;
    }

    if (!line.trim()) continue;

    const slash = handleSlashCommand(line, messages);
    if (slash === "exit") break;
    if (slash === "continue") continue;

    messages.push({ role: "user", content: line });

    await runTurn(client, messages, systemBlocks);
    process.stdout.write("\n");
  }

  console.log(chalk.dim("bye"));
}

main().catch((err) => {
  console.error(chalk.red("fatal:"), err);
  process.exit(1);
});

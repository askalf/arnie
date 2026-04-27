#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import process from "node:process";
import os from "node:os";

import { buildSystemBlocks } from "./systemPrompt.js";
import { SHELL_TOOL_DEFINITION, runShell, type ShellInput } from "./tools/shell.js";
import { READ_FILE_TOOL_DEFINITION, runReadFile, type ReadFileInput } from "./tools/readFile.js";
import { LIST_DIR_TOOL_DEFINITION, runListDir, type ListDirInput } from "./tools/listDir.js";
import { WRITE_FILE_TOOL_DEFINITION, runWriteFile, type WriteFileInput } from "./tools/writeFile.js";
import { prompt, closeReadline } from "./confirm.js";
import { parseArgs, HELP_TEXT, type Config } from "./config.js";
import { accumulate, emptyTotals, formatSessionTotals, formatTurnUsage } from "./usage.js";
import { createTranscriptWriter, type TranscriptWriter } from "./transcript.js";

const VERSION = "0.1.0";

const TOOLS: Anthropic.ToolUnion[] = [
  SHELL_TOOL_DEFINITION,
  READ_FILE_TOOL_DEFINITION,
  LIST_DIR_TOOL_DEFINITION,
  WRITE_FILE_TOOL_DEFINITION,
];

const BANNER = `${chalk.bold.cyan("arnie")} ${chalk.dim(`v${VERSION} — portable IT troubleshooting assistant`)}
${chalk.dim("type")} ${chalk.white("/help")} ${chalk.dim("for commands,")} ${chalk.white("/exit")} ${chalk.dim("to quit")}
`;

const REPL_HELP = `${chalk.bold("Slash commands:")}
  ${chalk.white("/help")}    show this help
  ${chalk.white("/clear")}   reset the conversation
  ${chalk.white("/usage")}   show session token totals and estimated cost
  ${chalk.white("/tools")}   list available tools
  ${chalk.white("/exit")}    quit (or Ctrl+C twice)
${chalk.bold("Tools available to the model:")}
  ${chalk.white("shell")}      run a shell command (destructive ops require confirmation)
  ${chalk.white("read_file")}  read a file from disk
  ${chalk.white("list_dir")}   list directory contents
  ${chalk.white("write_file")} write a file (always requires confirmation)
`;

async function executeTool(name: string, input: unknown): Promise<string> {
  if (name === "shell") return JSON.stringify(await runShell(input as ShellInput));
  if (name === "read_file") return JSON.stringify(await runReadFile(input as ReadFileInput));
  if (name === "list_dir") return JSON.stringify(await runListDir(input as ListDirInput));
  if (name === "write_file") return JSON.stringify(await runWriteFile(input as WriteFileInput));
  return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
}

interface TurnContext {
  client: Anthropic;
  config: Config;
  systemBlocks: Anthropic.TextBlockParam[];
  totals: ReturnType<typeof emptyTotals>;
  transcript: TranscriptWriter;
  abortController: { current: AbortController | null };
}

async function runTurn(
  ctx: TurnContext,
  messages: Anthropic.MessageParam[],
): Promise<void> {
  while (true) {
    process.stdout.write(chalk.dim("arnie: "));

    ctx.abortController.current = new AbortController();
    const stream = ctx.client.messages.stream(
      {
        model: ctx.config.model,
        max_tokens: ctx.config.maxTokens,
        thinking: ctx.config.thinking === "adaptive" ? { type: "adaptive" } : { type: "disabled" },
        output_config: { effort: ctx.config.effort },
        system: ctx.systemBlocks,
        messages,
        tools: TOOLS,
        cache_control: { type: "ephemeral" },
      },
      { signal: ctx.abortController.current.signal },
    );

    stream.on("text", (delta) => {
      process.stdout.write(delta);
    });

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      ctx.abortController.current = null;
      process.stdout.write("\n");
      const handled = handleApiError(err);
      await ctx.transcript.appendError(handled);
      console.error(chalk.red(handled));
      return;
    }
    ctx.abortController.current = null;

    process.stdout.write("\n");
    if (ctx.config.showUsage) {
      console.log(formatTurnUsage(ctx.config.model, message.usage));
    }
    accumulate(ctx.totals, ctx.config.model, message.usage);
    await ctx.transcript.appendAssistant(message);

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") return;
    if (message.stop_reason === "max_tokens") {
      console.log(chalk.yellow("[hit max_tokens — response was cut off]"));
      return;
    }
    if (message.stop_reason === "refusal") {
      console.log(chalk.yellow("[response was refused]"));
      return;
    }
    if (message.stop_reason === "pause_turn") continue;

    if (message.stop_reason !== "tool_use") {
      console.log(chalk.yellow(`[unexpected stop_reason: ${message.stop_reason}]`));
      return;
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

    await ctx.transcript.appendToolResults(toolResults);
    messages.push({ role: "user", content: toolResults });
  }
}

function handleApiError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    const retry = err.headers?.get("retry-after");
    return `rate limited${retry ? ` (retry after ${retry}s)` : ""}: ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return `authentication failed — check ANTHROPIC_API_KEY: ${err.message}`;
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `permission denied: ${err.message}`;
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `not found (model id?): ${err.message}`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `bad request: ${err.message}`;
  }
  if (err instanceof Anthropic.InternalServerError) {
    return `server error: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `network error: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `api error (${err.status ?? "?"}): ${err.message}`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("abort")) {
      return "request cancelled";
    }
    return `error: ${err.message}`;
  }
  return `error: ${String(err)}`;
}

function handleSlashCommand(
  line: string,
  messages: Anthropic.MessageParam[],
  totals: ReturnType<typeof emptyTotals>,
): "exit" | "continue" | null {
  const cmd = line.trim().toLowerCase();
  if (cmd === "/exit" || cmd === "/quit") return "exit";
  if (cmd === "/help" || cmd === "/?") {
    console.log(REPL_HELP);
    return "continue";
  }
  if (cmd === "/clear") {
    messages.length = 0;
    console.log(chalk.dim("conversation cleared"));
    return "continue";
  }
  if (cmd === "/usage") {
    console.log(formatSessionTotals(totals));
    return "continue";
  }
  if (cmd === "/tools") {
    for (const t of TOOLS) {
      const name = "name" in t ? t.name : "(unknown)";
      const desc = "description" in t && typeof t.description === "string" ? t.description : "";
      console.log(`  ${chalk.white(name)} — ${desc.split("\n")[0]}`);
    }
    return "continue";
  }
  return null;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`error: ${msg}`));
    console.error(`run with --help for usage`);
    process.exit(2);
  }

  if (config.showHelp) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (config.showVersion) {
    console.log(`arnie v${VERSION}`);
    process.exit(0);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red("error: ANTHROPIC_API_KEY is not set"));
    console.error(chalk.dim("get a key at https://console.anthropic.com and set it in your environment"));
    process.exit(1);
  }

  const client = new Anthropic({ maxRetries: 3 });
  const systemBlocks = buildSystemBlocks(config.systemExtra);
  const messages: Anthropic.MessageParam[] = [];
  const totals = emptyTotals();

  const transcript = createTranscriptWriter({
    enabled: config.transcript,
    dir: config.transcriptDir,
  });
  await transcript.startSession({
    model: config.model,
    effort: config.effort,
    cwd: process.cwd(),
    hostname: os.hostname(),
    user: os.userInfo().username,
  });

  process.stdout.write(BANNER);
  console.log(
    chalk.dim(
      `model=${config.model} effort=${config.effort} thinking=${config.thinking} max_tokens=${config.maxTokens}`,
    ),
  );
  if (transcript.enabled && transcript.path) {
    console.log(chalk.dim(`transcript: ${transcript.path}`));
  }
  console.log();

  const abortController: { current: AbortController | null } = { current: null };
  const ctx: TurnContext = {
    client,
    config,
    systemBlocks,
    totals,
    transcript,
    abortController,
  };

  let sigintCount = 0;
  process.on("SIGINT", () => {
    if (abortController.current) {
      console.log(chalk.dim("\n^C cancelling current request..."));
      abortController.current.abort();
      sigintCount = 0;
      return;
    }
    sigintCount += 1;
    if (sigintCount >= 2) {
      console.log("\n" + chalk.dim("bye"));
      shutdown(transcript, totals).then(() => process.exit(0));
      return;
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

    const slash = handleSlashCommand(line, messages, totals);
    if (slash === "exit") break;
    if (slash === "continue") continue;

    await transcript.appendUser(line);
    messages.push({ role: "user", content: line });

    await runTurn(ctx, messages);
    process.stdout.write("\n");
  }

  await shutdown(transcript, totals);
  console.log(chalk.dim("bye"));
  closeReadline();
}

async function shutdown(transcript: TranscriptWriter, totals: ReturnType<typeof emptyTotals>): Promise<void> {
  if (totals.turns > 0) {
    console.log(formatSessionTotals(totals));
  }
  try {
    await transcript.endSession();
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error(chalk.red("fatal:"), err);
  process.exit(1);
});

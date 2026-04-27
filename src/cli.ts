#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import process from "node:process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

import { buildSystemBlocks, appendMemoryBlock } from "./systemPrompt.js";
import { closeReadline } from "./confirm.js";
import { readUserInput } from "./input.js";
import { parseArgs, applySettings, HELP_TEXT, type Config } from "./config.js";
import { loadSettings } from "./settings.js";
import { accumulate, emptyTotals, formatSessionTotals, formatTurnUsage } from "./usage.js";
import { createTranscriptWriter, type TranscriptWriter } from "./transcript.js";
import { buildToolList, dispatchTool, isParallelSafe, type ToolContext } from "./tools/registry.js";
import { listJobs } from "./tools/backgroundShell.js";
import { setShellPermissions } from "./tools/shell.js";
import { saveSession, loadSession, listSessions, loadLastSession } from "./sessions.js";
import { loadMemoryFiles, formatMemoryBlock, type MemoryFile } from "./memory.js";
import { discoverSkills, formatSkillsBlock, type Skill } from "./skills.js";
import { loadPermissions } from "./permissions.js";
import { loadHooks, setHooks, describeHooks } from "./hooks.js";
import { initWorkspace } from "./init.js";
import { renderStatusLine } from "./statusLine.js";
import { createMarkdownRenderer } from "./markdown.js";
import { exportConversation } from "./export.js";

const VERSION = "0.4.0";
const COMPACT_BETA = "compact-2026-01-12";

const PLAN_MODE_BLOCK = `Plan mode is active. Before calling any tool that mutates state (write_file, edit_file, shell that modifies the system, shell_background, shell_kill) or making non-trivial changes, propose a numbered plan and wait for the user's explicit approval (e.g. "ok", "go", "proceed"). Read-only investigation tools (read_file, list_dir, grep, network_check, service_check, shell_status, subagent, web_search) may be used freely to inform the plan. Once approved, execute the plan step by step, narrating progress.`;

const BANNER = `${chalk.bold.cyan("arnie")} ${chalk.dim(`v${VERSION} — IT troubleshooting companion`)}
${chalk.dim("type")} ${chalk.white("/help")} ${chalk.dim("for commands,")} ${chalk.white(`"""`)} ${chalk.dim('for multi-line input,')} ${chalk.white("/exit")} ${chalk.dim("to quit")}
`;

const REPL_HELP = `${chalk.bold("Slash commands:")}
  ${chalk.white("/help")}            this help
  ${chalk.white("/usage")}           session token totals and estimated cost
  ${chalk.white("/clear")}           reset the conversation
  ${chalk.white("/tools")}           list registered tools
  ${chalk.white("/jobs")}            list background shell jobs
  ${chalk.white("/skills")}          list discovered skills
  ${chalk.white("/memory")}          show loaded memory files
  ${chalk.white("/remember <fact>")} append a line to .arnie/memory.md
  ${chalk.white("/cd <path>")}       change cwd
  ${chalk.white("/save <name>")}     save the current conversation
  ${chalk.white("/load <name>")}     load a saved conversation
  ${chalk.white("/list")}            list saved sessions
  ${chalk.white("/export <name>")}   export current conversation as markdown
  ${chalk.white("/plan")}            toggle plan mode
  ${chalk.white("/exit")}            quit (or Ctrl+C twice)
${chalk.bold("Input:")}
  Type a message and press Enter. Use ${chalk.white(`"""`)} on its own line to start
  and end multi-line mode (paste logs, stack traces, etc.).
${chalk.bold("Tools available to the model:")}
  ${chalk.white("shell, shell_background, shell_status, shell_kill")}
  ${chalk.white("read_file, write_file, edit_file, list_dir, grep")}
  ${chalk.white("network_check, service_check")}
  ${chalk.white("subagent")} (Haiku-backed read-only delegation)
  ${chalk.white("web_search")} (server-side)
`;

interface TurnContext {
  client: Anthropic;
  config: Config;
  baseSystemBlocks: Anthropic.TextBlockParam[];
  tools: Anthropic.ToolUnion[];
  totals: ReturnType<typeof emptyTotals>;
  transcript: TranscriptWriter;
  abortController: { current: AbortController | null };
  toolCtx: ToolContext;
  planMode: { current: boolean };
}

function buildSystemForTurn(ctx: TurnContext): Anthropic.TextBlockParam[] {
  if (!ctx.planMode.current) return ctx.baseSystemBlocks;
  return [...ctx.baseSystemBlocks, { type: "text", text: PLAN_MODE_BLOCK }];
}

async function runTurn(ctx: TurnContext, messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const renderer = createMarkdownRenderer(!ctx.config.noMarkdown);
    process.stdout.write(chalk.dim("arnie: "));

    ctx.abortController.current = new AbortController();

    const requestParams: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: ctx.config.model,
      max_tokens: ctx.config.maxTokens,
      thinking: ctx.config.thinking === "adaptive" ? { type: "adaptive" } : { type: "disabled" },
      output_config: { effort: ctx.config.effort },
      system: buildSystemForTurn(ctx),
      messages: messages as Anthropic.Beta.BetaMessageParam[],
      tools: ctx.tools as Anthropic.Beta.BetaToolUnion[],
      cache_control: { type: "ephemeral" },
      stream: true,
    };

    const edits: NonNullable<Anthropic.Beta.MessageCreateParams["context_management"]>["edits"] = [];
    if (ctx.config.compact) edits.push({ type: "compact_20260112" });
    if (!ctx.config.noContextEdit) edits.push({ type: "clear_tool_uses_20250919" });
    if (edits.length > 0) requestParams.context_management = { edits };

    const betas: string[] = [];
    if (ctx.config.compact) betas.push(COMPACT_BETA);

    const stream = ctx.client.beta.messages.stream(
      betas.length > 0 ? { ...requestParams, betas } : requestParams,
      { signal: ctx.abortController.current.signal },
    );

    stream.on("text", (delta) => {
      renderer.push(delta);
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      ctx.abortController.current = null;
      renderer.flush();
      process.stdout.write("\n");
      const handled = handleApiError(err);
      await ctx.transcript.appendError(handled);
      console.error(chalk.red(handled));
      return;
    }
    ctx.abortController.current = null;

    renderer.flush();
    process.stdout.write("\n");
    if (ctx.config.showUsage) {
      console.log(formatTurnUsage(ctx.config.model, message.usage));
    }
    accumulate(ctx.totals, ctx.config.model, message.usage);
    await ctx.transcript.appendAssistant(message as unknown as Anthropic.Message);

    messages.push({ role: "assistant", content: message.content as Anthropic.MessageParam["content"] });

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
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );

    const parallelGroup: Anthropic.Beta.BetaToolUseBlock[] = [];
    const serialGroup: Anthropic.Beta.BetaToolUseBlock[] = [];
    for (const t of toolUseBlocks) {
      if (isParallelSafe(t.name)) parallelGroup.push(t);
      else serialGroup.push(t);
    }

    const resultsById = new Map<string, string>();

    if (parallelGroup.length > 0) {
      if (parallelGroup.length > 1) {
        console.log(chalk.dim(`  [running ${parallelGroup.length} read-only tools in parallel]`));
      }
      await Promise.all(
        parallelGroup.map(async (t) => {
          const r = await dispatchTool(t.name, t.input, ctx.toolCtx);
          resultsById.set(t.id, r);
        }),
      );
    }
    for (const t of serialGroup) {
      const r = await dispatchTool(t.name, t.input, ctx.toolCtx);
      resultsById.set(t.id, r);
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((t) => ({
      type: "tool_result",
      tool_use_id: t.id,
      content: resultsById.get(t.id) ?? JSON.stringify({ ok: false, error: "tool result missing" }),
    }));

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

interface SlashContext {
  messages: Anthropic.MessageParam[];
  totals: ReturnType<typeof emptyTotals>;
  model: string;
  tools: Anthropic.ToolUnion[];
  memoryFiles: MemoryFile[];
  skills: Skill[];
  planMode: { current: boolean };
}

async function handleSlashCommand(line: string, ctx: SlashContext): Promise<"exit" | "continue" | null> {
  const trimmed = line.trim();
  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  const lower = cmd.toLowerCase();

  if (lower === "/exit" || lower === "/quit") return "exit";
  if (lower === "/help" || lower === "/?") {
    console.log(REPL_HELP);
    return "continue";
  }
  if (lower === "/clear") {
    ctx.messages.length = 0;
    console.log(chalk.dim("conversation cleared"));
    return "continue";
  }
  if (lower === "/usage") {
    console.log(formatSessionTotals(ctx.totals));
    return "continue";
  }
  if (lower === "/tools") {
    for (const t of ctx.tools) {
      const name = "name" in t ? t.name : "(unknown)";
      const desc =
        "description" in t && typeof (t as { description?: unknown }).description === "string"
          ? ((t as { description: string }).description.split("\n")[0] ?? "")
          : "";
      console.log(`  ${chalk.white(name)} — ${desc}`);
    }
    return "continue";
  }
  if (lower === "/jobs") {
    const js = listJobs();
    if (js.length === 0) {
      console.log(chalk.dim("no background jobs"));
    } else {
      for (const j of js) {
        console.log(`  ${chalk.white(j.id)} ${chalk.dim(`(${j.state}, ${j.elapsed_ms}ms, exit=${j.exit_code ?? "—"})`)} ${j.command}`);
      }
    }
    return "continue";
  }
  if (lower === "/skills") {
    if (ctx.skills.length === 0) {
      console.log(chalk.dim("no skills loaded (.arnie/skills/<name>/SKILL.md)"));
    } else {
      for (const s of ctx.skills) {
        console.log(`  ${chalk.white(s.name)} ${chalk.dim(`(${s.scope})`)} — ${s.description}`);
        console.log(chalk.dim(`    ${s.path}`));
      }
    }
    return "continue";
  }
  if (lower === "/memory") {
    if (ctx.memoryFiles.length === 0) {
      console.log(chalk.dim("no memory files loaded (looked for .arnie/memory.md, ARNIE.md, ~/.arnie/memory.md)"));
    } else {
      for (const f of ctx.memoryFiles) {
        console.log(chalk.bold(`--- ${f.scope}: ${f.path} ---`));
        console.log(f.content.trim());
        console.log();
      }
    }
    return "continue";
  }
  if (lower === "/remember") {
    if (!arg) {
      console.log(chalk.yellow("usage: /remember <fact>"));
      return "continue";
    }
    const projectMem = path.join(process.cwd(), ".arnie", "memory.md");
    try {
      await fs.mkdir(path.dirname(projectMem), { recursive: true });
      let exists = true;
      try {
        await fs.access(projectMem);
      } catch {
        exists = false;
      }
      const ts = new Date().toISOString().slice(0, 10);
      const newLine = `- ${arg} _(added ${ts})_\n`;
      if (!exists) {
        await fs.writeFile(projectMem, `# Arnie memory\n\n${newLine}`, "utf8");
      } else {
        await fs.appendFile(projectMem, newLine, "utf8");
      }
      console.log(chalk.dim(`appended to ${projectMem}`));
    } catch (err) {
      console.error(chalk.red(`failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return "continue";
  }
  if (lower === "/cd") {
    if (!arg) {
      console.log(`${chalk.dim("cwd:")} ${process.cwd()}`);
      return "continue";
    }
    try {
      const target = path.resolve(arg);
      process.chdir(target);
      console.log(chalk.dim(`cwd → ${target}`));
    } catch (err) {
      console.error(chalk.red(`cd failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return "continue";
  }
  if (lower === "/save") {
    if (!arg) {
      console.log(chalk.yellow("usage: /save <name>"));
      return "continue";
    }
    if (ctx.messages.length === 0) {
      console.log(chalk.yellow("nothing to save (conversation is empty)"));
      return "continue";
    }
    try {
      const file = await saveSession(arg, ctx.model, ctx.messages);
      console.log(chalk.dim(`saved ${ctx.messages.length} messages → ${file}`));
    } catch (err) {
      console.error(chalk.red(`save failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return "continue";
  }
  if (lower === "/load") {
    if (!arg) {
      console.log(chalk.yellow("usage: /load <name>"));
      return "continue";
    }
    try {
      const session = await loadSession(arg);
      if (!session) {
        console.log(chalk.yellow(`no saved session named "${arg}"`));
        return "continue";
      }
      ctx.messages.length = 0;
      ctx.messages.push(...session.messages);
      console.log(
        chalk.dim(`loaded ${session.messages.length} messages from ${session.name} (saved ${session.saved_at}, model ${session.model})`),
      );
    } catch (err) {
      console.error(chalk.red(`load failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return "continue";
  }
  if (lower === "/list") {
    const ss = await listSessions();
    if (ss.length === 0) {
      console.log(chalk.dim("no saved sessions"));
    } else {
      for (const s of ss) {
        console.log(`  ${chalk.white(s.name)}  ${chalk.dim(`${s.saved_at}  turns=${s.turns}  ${s.bytes}b  ${s.model}`)}`);
      }
    }
    return "continue";
  }
  if (lower === "/export") {
    if (!arg) {
      console.log(chalk.yellow("usage: /export <name>"));
      return "continue";
    }
    if (ctx.messages.length === 0) {
      console.log(chalk.yellow("nothing to export"));
      return "continue";
    }
    try {
      const file = await exportConversation(arg, ctx.model, ctx.messages);
      console.log(chalk.dim(`exported ${ctx.messages.length} messages → ${file}`));
    } catch (err) {
      console.error(chalk.red(`export failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return "continue";
  }
  if (lower === "/plan") {
    ctx.planMode.current = !ctx.planMode.current;
    console.log(chalk.magenta(`plan mode ${ctx.planMode.current ? "ON" : "OFF"}`));
    if (ctx.planMode.current) {
      console.log(chalk.dim("the model will propose a plan before mutating tools; approve with 'ok'/'go'/'proceed'."));
    }
    return "continue";
  }
  return null;
}

async function runPrintMode(ctx: TurnContext, message: string): Promise<void> {
  await ctx.transcript.appendUser(message);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: message }];
  await runTurn(ctx, messages);
}

async function main(): Promise<void> {
  let initialConfig: Config;
  try {
    const { settings, source: settingsSource } = await loadSettings();
    const base = applySettings(settings);
    initialConfig = parseArgs(process.argv.slice(2), base);
    if (settingsSource && !initialConfig.showHelp && !initialConfig.showVersion && !initialConfig.init) {
      // log only when actually running the REPL
      console.log(chalk.dim(`settings: ${settingsSource}`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`error: ${msg}`));
    console.error(`run with --help for usage`);
    process.exit(2);
  }

  const config = initialConfig;

  if (config.showHelp) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (config.showVersion) {
    console.log(`arnie v${VERSION}`);
    process.exit(0);
  }
  if (config.init) {
    await initWorkspace();
    process.exit(0);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red("error: ANTHROPIC_API_KEY is not set"));
    console.error(chalk.dim("get a key at https://console.anthropic.com and set it in your environment"));
    process.exit(1);
  }

  const client = new Anthropic({ maxRetries: 3 });
  let baseSystemBlocks = buildSystemBlocks(config.systemExtra);

  const memoryFiles = config.noMemory ? [] : await loadMemoryFiles();
  if (memoryFiles.length > 0) {
    baseSystemBlocks = appendMemoryBlock(baseSystemBlocks, formatMemoryBlock(memoryFiles));
  }

  const skills = config.noSkills ? [] : await discoverSkills();
  if (skills.length > 0) {
    baseSystemBlocks = appendMemoryBlock(baseSystemBlocks, formatSkillsBlock(skills));
  }

  if (!config.noPermissions) {
    try {
      const perms = await loadPermissions();
      setShellPermissions(perms);
      if (perms.source) {
        console.log(chalk.dim(`permissions: ${perms.source} (allow=${perms.allow.length}, deny=${perms.deny.length})`));
      }
    } catch (err) {
      console.error(chalk.red(`permissions load failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  if (!config.noHooks) {
    try {
      const hooks = await loadHooks();
      setHooks(hooks);
      if (hooks.source) {
        console.log(chalk.dim(`hooks: ${describeHooks()}`));
      }
    } catch (err) {
      console.error(chalk.red(`hooks load failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  const tools = buildToolList({ webSearch: !config.noWebSearch, subagent: !config.noSubagent });
  const toolCtx: ToolContext = { client };

  const messages: Anthropic.MessageParam[] = [];
  if (config.resume || config.resumeLast) {
    try {
      const session = config.resume
        ? await loadSession(config.resume)
        : await loadLastSession();
      if (!session) {
        const target = config.resume ?? "(most recent)";
        console.error(chalk.red(`no saved session matching "${target}"`));
        process.exit(1);
      }
      messages.push(...session.messages);
      console.log(chalk.dim(`resumed ${session.messages.length} messages from ${session.name}`));
    } catch (err) {
      console.error(chalk.red(`failed to resume: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  }

  const totals = emptyTotals();
  const planMode = { current: false };

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

  const abortController: { current: AbortController | null } = { current: null };
  const ctx: TurnContext = {
    client,
    config,
    baseSystemBlocks,
    tools,
    totals,
    transcript,
    abortController,
    toolCtx,
    planMode,
  };

  if (config.printMessage) {
    await runPrintMode(ctx, config.printMessage);
    await transcript.endSession();
    closeReadline();
    process.exit(0);
  }

  process.stdout.write(BANNER);
  console.log(
    chalk.dim(
      `model=${config.model} effort=${config.effort} thinking=${config.thinking} compact=${config.compact} max_tokens=${config.maxTokens}`,
    ),
  );
  if (memoryFiles.length > 0) {
    console.log(chalk.dim(`memory: ${memoryFiles.map((f) => f.path).join(", ")}`));
  }
  if (skills.length > 0) {
    console.log(chalk.dim(`skills: ${skills.length} loaded (${skills.map((s) => s.name).join(", ")})`));
  }
  if (transcript.enabled && transcript.path) {
    console.log(chalk.dim(`transcript: ${transcript.path}`));
  }
  console.log();

  const slashCtx: SlashContext = {
    messages,
    totals,
    model: config.model,
    tools,
    memoryFiles,
    skills,
    planMode,
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
    if (!config.noStatusLine) {
      console.log(
        renderStatusLine({
          model: config.model,
          effort: config.effort,
          cwd: process.cwd(),
          totals,
          planMode: planMode.current,
        }),
      );
    }
    const line = await readUserInput();
    if (line === null) break;
    if (!line.trim()) continue;

    if (line.trim().startsWith("/")) {
      const slash = await handleSlashCommand(line, slashCtx);
      if (slash === "exit") break;
      if (slash === "continue") continue;
    }

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

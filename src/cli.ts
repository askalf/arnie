#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import process from "node:process";
import os from "node:os";

import { buildSystemBlocks, appendMemoryBlock } from "./systemPrompt.js";
import { closeReadline } from "./confirm.js";
import { readUserInput } from "./input.js";
import { parseArgs, applySettings, HELP_TEXT, type Config } from "./config.js";
import { loadSettings } from "./settings.js";
import { accumulate, emptyTotals, formatSessionTotals, formatTurnUsage } from "./usage.js";
import { createTranscriptWriter, type TranscriptWriter } from "./transcript.js";
import { buildToolList, dispatchTool, isParallelSafe, type ToolContext } from "./tools/registry.js";
import { setShellPermissions } from "./tools/shell.js";
import { loadSession, saveSession, loadLastSession } from "./sessions.js";
import { loadMemoryFiles, formatMemoryBlock, type MemoryFile } from "./memory.js";
import { discoverSkills, formatSkillsBlock, type Skill } from "./skills.js";
import { loadPermissions } from "./permissions.js";
import { loadHooks, setHooks, describeHooks } from "./hooks.js";
import { initWorkspace } from "./init.js";
import { renderStatusLine } from "./statusLine.js";
import { createMarkdownRenderer } from "./markdown.js";
import { loadMcpConfig, type McpConfig } from "./mcp.js";
import { parseInput } from "./attach.js";
import { bufferDelta, flushSpeech } from "./voice.js";
import { setQuiet } from "./log.js";
import { setDryRun } from "./dryRun.js";
import { loadRedactors, setRedactors, describeRedactors } from "./redactors.js";
import { loadPersonaOverride } from "./persona.js";
import { loadSandbox, setSandbox, describeSandbox } from "./sandbox.js";
import { getUnannouncedFinishedJobs } from "./tools/backgroundShell.js";
import { loadFeedback, feedbackPath } from "./feedback.js";
import { handleApiError } from "./apiError.js";
import { handleSlashCommand, type SlashContext } from "./slashCommands.js";

const VERSION = "1.1.3";
const COMPACT_BETA = "compact-2026-01-12";

const PLAN_MODE_BLOCK = `Plan mode is active. Before calling any tool that mutates state (write_file, edit_file, shell that modifies the system, shell_background, shell_kill) or making non-trivial changes, propose a numbered plan and wait for the user's explicit approval (e.g. "ok", "go", "proceed"). Read-only investigation tools (read_file, list_dir, grep, network_check, service_check, shell_status, subagent, web_search) may be used freely to inform the plan. Once approved, execute the plan step by step, narrating progress.`;

const BANNER = `${chalk.bold.cyan("arnie")} ${chalk.dim(`v${VERSION} — IT troubleshooting companion`)}
${chalk.dim("type")} ${chalk.white("/help")} ${chalk.dim("for commands,")} ${chalk.white(`"""`)} ${chalk.dim('for multi-line input,')} ${chalk.white("/exit")} ${chalk.dim("to quit")}
`;

const REPL_HELP = `${chalk.bold("Slash commands:")}
  ${chalk.white("/help")}            this help
  ${chalk.white("/usage")}           session token totals and estimated cost
  ${chalk.white("/usage tools")}     per-tool call counts and durations
  ${chalk.white("/clear")}           reset the conversation
  ${chalk.white("/clear --summary")} summarize then reset
  ${chalk.white("/tools")}           list registered tools
  ${chalk.white("/jobs")}            list background shell jobs
  ${chalk.white("/jobs --watch")}    block until all background jobs finish
  ${chalk.white("/skills")}          list discovered skills
  ${chalk.white("/memory")}          show loaded memory files
  ${chalk.white("/remember <fact>")} append a line to .arnie/memory.md
  ${chalk.white("/cd <path>")}       change cwd
  ${chalk.white("/save <name>")}     save the current conversation
  ${chalk.white("/load <name>")}     load a saved conversation
  ${chalk.white("/list")}            list saved sessions
  ${chalk.white("/find <query>")}    search across saved sessions
  ${chalk.white("/export <name>")}   export current conversation as markdown
  ${chalk.white("/plan")}            toggle plan mode
  ${chalk.white("/profile")}         show model details (capabilities, context window)
  ${chalk.white("/init")}            ask the model to bootstrap memory.md from machine probes
  ${chalk.white("/settings")}        view current settings
  ${chalk.white("/exit")}            quit (or Ctrl+C twice)
${chalk.bold("Input:")}
  Plain text. Use ${chalk.white(`"""`)} on its own line for multi-line input.
  ${chalk.white("@path/to/file")} auto-attaches a file (image or text).
  ${chalk.white("attach <path>")} also attaches; multi-occurrence supported.
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
  mcp: McpConfig;
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

    if (ctx.mcp.servers.length > 0) {
      requestParams.mcp_servers = ctx.mcp.servers as unknown as Anthropic.Beta.MessageCreateParams["mcp_servers"];
    }

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
      if (ctx.config.voice) bufferDelta(delta);
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
    if (ctx.config.voice) flushSpeech();
    if (ctx.config.showUsage && !ctx.config.quiet) {
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


async function runPrintMode(ctx: TurnContext, message: string): Promise<void> {
  await ctx.transcript.appendUser(message);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: message }];
  await runTurn(ctx, messages);
  // The single turn has already executed by the time we get here, so we
  // can't *prevent* the spend — but cron/script users still need a signal.
  // Warn to stderr and exit non-zero so wrappers can react.
  if (ctx.config.budgetUsd && ctx.totals.costUsd >= ctx.config.budgetUsd) {
    console.error(chalk.yellow(
      `budget exceeded: $${ctx.totals.costUsd.toFixed(4)} ≥ $${ctx.config.budgetUsd.toFixed(4)}`,
    ));
    process.exitCode = 1;
  }
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

  // --dario sets a sensible default base URL + dummy key if unset, so users
  // don't have to remember to export both env vars.
  if (config.dario) {
    if (!config.baseUrl) config.baseUrl = "http://localhost:3456";
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "dario";
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red("error: ANTHROPIC_API_KEY is not set"));
    console.error(chalk.dim("get a key at https://console.anthropic.com and set it in your environment"));
    console.error(chalk.dim("(or run with --dario to route through a local dario proxy)"));
    process.exit(1);
  }

  setQuiet(config.quiet);
  setDryRun(config.dryRun);

  const clientOpts: ConstructorParameters<typeof Anthropic>[0] = { maxRetries: 3 };
  if (config.baseUrl) clientOpts.baseURL = config.baseUrl;
  const client = new Anthropic(clientOpts);
  if (config.baseUrl) {
    console.log(chalk.dim(`base url: ${config.baseUrl}${config.dario ? " (via --dario)" : ""}`));
  }

  let personaText: string | undefined = config.systemExtra;
  if (!config.noMemory) {
    try {
      const persona = await loadPersonaOverride();
      if (persona) {
        const tag = `Persona override (loaded from ${persona.source}):\n${persona.text}`;
        personaText = personaText ? `${personaText}\n\n${tag}` : tag;
        console.log(chalk.dim(`persona: ${persona.source}`));
      }
    } catch (err) {
      console.error(chalk.red(`persona load failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  let baseSystemBlocks = buildSystemBlocks(personaText);

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

  try {
    const redactors = await loadRedactors();
    setRedactors(redactors);
    console.log(chalk.dim(`redactors: ${describeRedactors()}`));
  } catch (err) {
    console.error(chalk.red(`redactors load failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  if (!config.noSandbox) {
    try {
      const sandbox = await loadSandbox();
      setSandbox(sandbox);
      if (sandbox.source) {
        console.log(chalk.dim(`sandbox: ${describeSandbox()}`));
      }
    } catch (err) {
      console.error(chalk.red(`sandbox load failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Pre-load any feedback from previous session and inject as a system block
  try {
    const fb = await loadFeedback();
    if (fb && !config.noMemory) {
      baseSystemBlocks = appendMemoryBlock(baseSystemBlocks, `Feedback from prior sessions (loaded from ${feedbackPath()}):\n\n${fb}`);
      console.log(chalk.dim(`feedback: ${feedbackPath()}`));
    }
  } catch (err) {
    console.error(chalk.red(`feedback load failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  let mcpConfig: McpConfig = { servers: [], source: null };
  if (!config.noMcp) {
    try {
      mcpConfig = await loadMcpConfig();
      if (mcpConfig.source && mcpConfig.servers.length > 0) {
        console.log(chalk.dim(`mcp: ${mcpConfig.servers.length} server(s) — ${mcpConfig.servers.map((s) => s.name).join(", ")}`));
      }
    } catch (err) {
      console.error(chalk.red(`mcp load failed: ${err instanceof Error ? err.message : String(err)}`));
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
  const clearBaseline = emptyTotals();
  const planMode = { current: false };
  let userTurnsSinceCheckpoint = 0;

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
    mcp: mcpConfig,
  };

  if (config.printMessage) {
    await runPrintMode(ctx, config.printMessage);
    await transcript.endSession();
    closeReadline();
    // No-arg form honors process.exitCode (set by runPrintMode on budget overrun).
    process.exit();
  }

  process.stdout.write(BANNER);
  console.log(
    chalk.dim(
      `model=${config.model} effort=${config.effort} thinking=${config.thinking} compact=${config.compact} max_tokens=${config.maxTokens}${config.dryRun ? " " + chalk.magenta("[dry-run]") : ""}`,
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
    clearBaseline,
    model: config.model,
    tools,
    memoryFiles,
    skills,
    planMode,
    helpText: REPL_HELP,
    turnRef: {
      client,
      config: { model: config.model },
      runTurn: (msgs) => runTurn(ctx, msgs),
    },
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

    const parsed = await parseInput(line);
    for (const e of parsed.errors) console.warn(chalk.yellow(e));
    if (parsed.attachments.length > 0) {
      for (const a of parsed.attachments) {
        console.log(chalk.dim(`  attached ${a.type}: ${a.path} (${a.bytes} bytes)`));
      }
    }

    // Inject system reminders for any background jobs that finished since
    // the last user turn — the model would otherwise be unaware.
    const finishedJobs = getUnannouncedFinishedJobs();
    let userContent: Anthropic.MessageParam["content"];
    let userTextForTranscript = line;
    if (finishedJobs.length > 0) {
      const reminder = `<system-reminder>\n${finishedJobs.length} background job${finishedJobs.length === 1 ? "" : "s"} finished since the last turn:\n${finishedJobs
        .map((j) => `- ${j.id}: \`${j.command}\` exit=${j.exit_code ?? (j.killed ? "killed" : "?")} elapsed=${j.elapsed_ms}ms`)
        .join("\n")}\nUse shell_status with the job_id to read the output if relevant.\n</system-reminder>\n\n`;
      userTextForTranscript = reminder + line;
      if (parsed.blocks.length === 1 && parsed.blocks[0].type === "text") {
        userContent = reminder + line;
      } else {
        userContent = [{ type: "text", text: reminder } as Anthropic.TextBlockParam, ...parsed.blocks];
      }
    } else {
      if (parsed.blocks.length === 1 && parsed.blocks[0].type === "text") {
        userContent = line;
      } else {
        userContent = parsed.blocks;
      }
    }

    await transcript.appendUser(userTextForTranscript);
    messages.push({ role: "user", content: userContent });

    await runTurn(ctx, messages);
    process.stdout.write("\n");

    // Budget enforcement
    if (config.budgetUsd && totals.costUsd >= config.budgetUsd) {
      console.log(chalk.yellow(`\nbudget exceeded: $${totals.costUsd.toFixed(4)} ≥ $${config.budgetUsd.toFixed(4)} — exiting`));
      break;
    }

    // Auto-checkpoint
    if (config.autoCheckpoint) {
      userTurnsSinceCheckpoint += 1;
      if (userTurnsSinceCheckpoint >= config.autoCheckpoint) {
        try {
          const file = await saveSession(`checkpoint-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`, config.model, messages);
          console.log(chalk.dim(`auto-checkpoint → ${file}`));
        } catch (err) {
          console.error(chalk.red(`checkpoint failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        userTurnsSinceCheckpoint = 0;
      }
    }
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

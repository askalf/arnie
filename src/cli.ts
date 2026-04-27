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
import { searchSessions } from "./sessions.js";
import { loadMcpConfig, type McpConfig } from "./mcp.js";
import { parseInput } from "./attach.js";
import { bufferDelta, flushSpeech, clearSpeechBuffer } from "./voice.js";
import { formatToolStats, resetToolStats } from "./toolStats.js";
import { writeSettings, loadSettings as loadSettingsFile } from "./settings.js";
import { setQuiet } from "./log.js";
import { loadRedactors, setRedactors, describeRedactors } from "./redactors.js";
import { describeModel } from "./profile.js";
import { loadPersonaOverride } from "./persona.js";

const VERSION = "0.6.0";
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
  turnCtx: TurnContext;
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
    if (arg === "--summary") {
      await summarizeAndClear(ctx);
    } else {
      ctx.messages.length = 0;
      resetToolStats();
      console.log(chalk.dim("conversation cleared"));
    }
    return "continue";
  }
  if (lower === "/usage") {
    if (arg === "tools") {
      console.log(formatToolStats());
    } else {
      console.log(formatSessionTotals(ctx.totals));
    }
    return "continue";
  }
  if (lower === "/find") {
    if (!arg) {
      console.log(chalk.yellow("usage: /find <query>"));
      return "continue";
    }
    const hits = await searchSessions(arg);
    if (hits.length === 0) {
      console.log(chalk.dim(`no matches for "${arg}"`));
    } else {
      console.log(chalk.bold(`${hits.length} matches:`));
      for (const h of hits) {
        console.log(`  ${chalk.white(h.session)} ${chalk.dim(`@${h.message_index} (${h.role}, ${h.saved_at})`)}`);
        console.log(`    ${h.snippet}`);
      }
    }
    return "continue";
  }
  if (lower === "/settings") {
    if (!arg) {
      const { settings, source } = await loadSettingsFile();
      console.log(chalk.dim(`source: ${source ?? "(none — defaults)"}`));
      console.log(JSON.stringify(settings, null, 2));
      return "continue";
    }
    const [key, ...valParts] = arg.split(/\s+/);
    const valueRaw = valParts.join(" ").trim();
    if (!key || !valueRaw) {
      console.log(chalk.yellow("usage: /settings | /settings <key> <value>"));
      return "continue";
    }
    try {
      const { settings } = await loadSettingsFile();
      let value: unknown = valueRaw;
      if (valueRaw === "true") value = true;
      else if (valueRaw === "false") value = false;
      else if (/^-?\d+$/.test(valueRaw)) value = parseInt(valueRaw, 10);
      (settings as Record<string, unknown>)[key] = value;
      const file = await writeSettings(settings);
      console.log(chalk.dim(`set ${key}=${JSON.stringify(value)} → ${file}`));
      console.log(chalk.dim(`(takes effect on next start)`));
    } catch (err) {
      console.error(chalk.red(`failed: ${err instanceof Error ? err.message : String(err)}`));
    }
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
    if (arg === "--watch") {
      await watchJobs();
    } else {
      const js = listJobs();
      if (js.length === 0) {
        console.log(chalk.dim("no background jobs"));
      } else {
        for (const j of js) {
          console.log(`  ${chalk.white(j.id)} ${chalk.dim(`(${j.state}, ${j.elapsed_ms}ms, exit=${j.exit_code ?? "—"})`)} ${j.command}`);
        }
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
  if (lower === "/profile") {
    const tCtx = ctx.turnCtx;
    console.log(await describeModel(tCtx.client, tCtx.config.model));
    return "continue";
  }
  if (lower === "/init") {
    const bootstrap = `Bootstrap a memory.md for this machine. Use shell, list_dir, network_check, and service_check to probe:
- OS, version, architecture
- Hostname and primary network adapter info
- Whether common services (DNS, network) are reachable
- Notable installed software you can quickly detect (Docker, Node, Python, package managers)
- The contents and structure of the current working directory (basic shape only)

Then propose a concise memory.md with stable, factual context (no temporary state, no tool output dumps). Save it via write_file to .arnie/memory.md (the user will confirm). Keep the file under 60 lines.`;
    ctx.messages.push({ role: "user", content: bootstrap });
    await runTurn(ctx.turnCtx, ctx.messages);
    process.stdout.write("\n");
    return "continue";
  }
  return null;
}

async function watchJobs(): Promise<void> {
  while (true) {
    const js = listJobs();
    const running = js.filter((j) => j.state === "running");
    if (running.length === 0) {
      console.log(chalk.dim("all background jobs done"));
      for (const j of js) {
        console.log(`  ${chalk.white(j.id)} ${chalk.dim(`(${j.state}, ${j.elapsed_ms}ms, exit=${j.exit_code ?? "—"})`)} ${j.command}`);
      }
      return;
    }
    process.stdout.write(`\r${chalk.dim(`${running.length} job${running.length === 1 ? "" : "s"} running... `)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function summarizeAndClear(slashCtx: SlashContext): Promise<void> {
  if (slashCtx.messages.length === 0) {
    console.log(chalk.dim("nothing to summarize"));
    return;
  }
  console.log(chalk.dim("summarizing conversation before clear..."));

  const ctx = slashCtx.turnCtx;
  const summaryRequest: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: "You produce a 3-5 sentence summary of an IT troubleshooting conversation. Capture the user's problem, what was investigated, what was decided, and any outstanding items. Be concise and factual. No preamble.",
      },
    ],
    messages: slashCtx.messages as Anthropic.Beta.BetaMessageParam[],
  };

  try {
    const resp = await ctx.client.beta.messages.create(summaryRequest);
    const text = resp.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    slashCtx.messages.length = 0;
    if (text) {
      slashCtx.messages.push({
        role: "user",
        content: `[Earlier conversation summary]\n${text}\n\n[End of summary — continuing fresh from here.]`,
      });
      console.log(chalk.dim("--- summary ---"));
      console.log(text);
      console.log(chalk.dim("--- end summary ---"));
    }
    resetToolStats();
    console.log(chalk.dim("conversation reset to summary"));
  } catch (err) {
    console.error(chalk.red(`summary failed: ${err instanceof Error ? err.message : String(err)}`));
    console.error(chalk.dim("conversation NOT cleared"));
  }
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

  setQuiet(config.quiet);

  const client = new Anthropic({ maxRetries: 3 });

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
    mcp: mcpConfig,
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
    turnCtx: ctx,
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
    await transcript.appendUser(line);
    if (parsed.blocks.length === 1 && parsed.blocks[0].type === "text") {
      messages.push({ role: "user", content: line });
    } else {
      messages.push({ role: "user", content: parsed.blocks });
    }

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

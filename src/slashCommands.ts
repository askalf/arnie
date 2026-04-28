import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import fs from "node:fs/promises";
import path from "node:path";

import { listJobs } from "./tools/backgroundShell.js";
import { saveSession, loadSession, listSessions, searchSessions } from "./sessions.js";
import type { MemoryFile } from "./memory.js";
import type { Skill } from "./skills.js";
import { exportConversation } from "./export.js";
import { appendFeedback, loadFeedback, clearFeedback, feedbackPath } from "./feedback.js";
import { writeSettings, loadSettings as loadSettingsFile } from "./settings.js";
import { describeModel } from "./profile.js";
import { formatToolStats, resetToolStats } from "./toolStats.js";
import {
  emptyTotals,
  formatSessionTotals,
  deltaTotals,
  snapshotTotals,
} from "./usage.js";

/**
 * Minimal subset of TurnContext that slash commands need. Defined here so the
 * module doesn't depend on the cli.ts TurnContext type (which would create a
 * circular import). cli.ts wires concrete values into this shape.
 */
export interface SlashTurnRef {
  client: Anthropic;
  config: { model: string };
  runTurn: (messages: Anthropic.MessageParam[]) => Promise<void>;
}

export interface SlashContext {
  messages: Anthropic.MessageParam[];
  totals: ReturnType<typeof emptyTotals>;
  clearBaseline: ReturnType<typeof emptyTotals>;
  model: string;
  tools: Anthropic.ToolUnion[];
  memoryFiles: MemoryFile[];
  skills: Skill[];
  planMode: { current: boolean };
  turnRef: SlashTurnRef;
  helpText: string;
}

export async function watchJobs(): Promise<void> {
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

async function summarizeAndClear(ctx: SlashContext): Promise<void> {
  if (ctx.messages.length === 0) {
    console.log(chalk.dim("nothing to summarize"));
    return;
  }
  console.log(chalk.dim("summarizing conversation before clear..."));

  const summaryRequest: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: "You produce a 3-5 sentence summary of an IT troubleshooting conversation. Capture the user's problem, what was investigated, what was decided, and any outstanding items. Be concise and factual. No preamble.",
      },
    ],
    messages: ctx.messages as Anthropic.Beta.BetaMessageParam[],
  };

  try {
    const resp = await ctx.turnRef.client.beta.messages.create(summaryRequest);
    const text = resp.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    ctx.messages.length = 0;
    if (text) {
      ctx.messages.push({
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

export async function handleSlashCommand(line: string, ctx: SlashContext): Promise<"exit" | "continue" | null> {
  const trimmed = line.trim();
  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  const lower = cmd.toLowerCase();

  if (lower === "/exit" || lower === "/quit") return "exit";
  if (lower === "/help" || lower === "/?") {
    console.log(ctx.helpText);
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
    Object.assign(ctx.clearBaseline, snapshotTotals(ctx.totals));
    return "continue";
  }
  if (lower === "/usage") {
    if (arg === "tools") {
      console.log(formatToolStats());
    } else if (arg === "--since-clear") {
      const delta = deltaTotals(ctx.totals, ctx.clearBaseline);
      console.log(chalk.bold("usage since last /clear:"));
      console.log(formatSessionTotals(delta));
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
    console.log(await describeModel(ctx.turnRef.client, ctx.turnRef.config.model));
    return "continue";
  }
  if (lower === "/feedback") {
    if (!arg) {
      const text = await loadFeedback();
      if (!text) {
        console.log(chalk.dim(`no feedback yet (will be loaded next session from ${feedbackPath()})`));
      } else {
        console.log(chalk.dim(`current feedback (${feedbackPath()}):`));
        console.log(text);
      }
      return "continue";
    }
    if (arg === "--clear") {
      await clearFeedback();
      console.log(chalk.dim("feedback cleared"));
      return "continue";
    }
    try {
      const file = await appendFeedback(arg);
      console.log(chalk.dim(`appended → ${file}`));
    } catch (err) {
      console.error(chalk.red(`feedback failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return "continue";
  }
  if (lower === "/replay") {
    if (!arg) {
      console.log(chalk.yellow("usage: /replay <transcript-jsonl-path>"));
      return "continue";
    }
    try {
      const raw = await fs.readFile(arg, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      let userMsgs = 0;
      ctx.messages.length = 0;
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as { kind?: string; content?: unknown };
          if (rec.kind === "user" && typeof rec.content === "string") {
            ctx.messages.push({ role: "user", content: rec.content });
            userMsgs += 1;
          } else if (rec.kind === "assistant" && rec.content) {
            ctx.messages.push({ role: "assistant", content: rec.content as Anthropic.MessageParam["content"] });
          }
        } catch {
          // skip bad lines
        }
      }
      console.log(chalk.dim(`replayed ${userMsgs} user message(s) from ${arg} (${ctx.messages.length} total)`));
    } catch (err) {
      console.error(chalk.red(`replay failed: ${err instanceof Error ? err.message : String(err)}`));
    }
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
    await ctx.turnRef.runTurn(ctx.messages);
    process.stdout.write("\n");
    return "continue";
  }
  return null;
}

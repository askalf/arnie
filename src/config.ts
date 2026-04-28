export interface Config {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  thinking: "adaptive" | "disabled";
  transcript: boolean;
  transcriptDir?: string;
  showUsage: boolean;
  systemExtra?: string;
  showHelp: boolean;
  showVersion: boolean;
  compact: boolean;
  resume?: string;
  resumeLast: boolean;
  noWebSearch: boolean;
  noMemory: boolean;
  noSubagent: boolean;
  noSkills: boolean;
  noPermissions: boolean;
  noHooks: boolean;
  noContextEdit: boolean;
  noStatusLine: boolean;
  noMarkdown: boolean;
  noMcp: boolean;
  noSandbox: boolean;
  dryRun: boolean;
  budgetUsd?: number;
  autoCheckpoint?: number;
  quiet: boolean;
  voice: boolean;
  init: boolean;
  printMessage?: string;
}

const DEFAULTS: Config = {
  model: "claude-opus-4-7",
  effort: "xhigh",
  maxTokens: 64000,
  thinking: "adaptive",
  transcript: true,
  showUsage: true,
  showHelp: false,
  showVersion: false,
  compact: true,
  resumeLast: false,
  noWebSearch: false,
  noMemory: false,
  noSubagent: false,
  noSkills: false,
  noPermissions: false,
  noHooks: false,
  noContextEdit: false,
  noStatusLine: false,
  noMarkdown: false,
  noMcp: false,
  noSandbox: false,
  dryRun: false,
  quiet: false,
  voice: false,
  init: false,
};

import type { Settings } from "./settings.js";

export function applySettings(settings: Settings): Config {
  const c: Config = { ...DEFAULTS };
  if (settings.model) c.model = settings.model;
  if (settings.effort) c.effort = settings.effort;
  if (typeof settings.maxTokens === "number") c.maxTokens = settings.maxTokens;
  if (settings.thinking) c.thinking = settings.thinking;
  if (typeof settings.compact === "boolean") c.compact = settings.compact;
  if (typeof settings.contextEdit === "boolean") c.noContextEdit = !settings.contextEdit;
  if (typeof settings.webSearch === "boolean") c.noWebSearch = !settings.webSearch;
  if (typeof settings.subagent === "boolean") c.noSubagent = !settings.subagent;
  if (typeof settings.skills === "boolean") c.noSkills = !settings.skills;
  if (typeof settings.memory === "boolean") c.noMemory = !settings.memory;
  if (typeof settings.permissions === "boolean") c.noPermissions = !settings.permissions;
  if (typeof settings.transcript === "boolean") c.transcript = settings.transcript;
  if (settings.transcriptDir) c.transcriptDir = settings.transcriptDir;
  if (typeof settings.showUsage === "boolean") c.showUsage = settings.showUsage;
  if (typeof settings.statusLine === "boolean") c.noStatusLine = !settings.statusLine;
  if (typeof settings.markdown === "boolean") c.noMarkdown = !settings.markdown;
  if (settings.systemExtra) c.systemExtra = settings.systemExtra;
  return c;
}

const VALID_EFFORTS: Config["effort"][] = ["low", "medium", "high", "xhigh", "max"];

export function parseArgs(argv: string[], base?: Config): Config {
  const config: Config = base ? { ...base } : { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (label: string): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${label} requires a value`);
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        config.showHelp = true;
        break;
      case "--version":
        config.showVersion = true;
        break;
      case "--model":
        config.model = next("--model");
        break;
      case "--effort": {
        const v = next("--effort") as Config["effort"];
        if (!VALID_EFFORTS.includes(v)) {
          throw new Error(`--effort must be one of: ${VALID_EFFORTS.join(", ")}`);
        }
        config.effort = v;
        break;
      }
      case "--max-tokens": {
        const v = parseInt(next("--max-tokens"), 10);
        if (!Number.isFinite(v) || v <= 0) {
          throw new Error("--max-tokens must be a positive integer");
        }
        config.maxTokens = v;
        break;
      }
      case "--no-thinking":
        config.thinking = "disabled";
        break;
      case "--no-transcript":
        config.transcript = false;
        break;
      case "--transcript-dir":
        config.transcriptDir = next("--transcript-dir");
        break;
      case "--no-usage":
        config.showUsage = false;
        break;
      case "--system-extra":
        config.systemExtra = next("--system-extra");
        break;
      case "--no-compact":
        config.compact = false;
        break;
      case "--resume":
        if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          config.resume = next("--resume");
        } else {
          config.resumeLast = true;
        }
        break;
      case "--print":
      case "-p":
        config.printMessage = next("--print");
        break;
      case "--no-status-line":
        config.noStatusLine = true;
        break;
      case "--no-markdown":
        config.noMarkdown = true;
        break;
      case "--no-hooks":
        config.noHooks = true;
        break;
      case "--no-mcp":
        config.noMcp = true;
        break;
      case "--quiet":
      case "-q":
        config.quiet = true;
        break;
      case "--voice":
        config.voice = true;
        break;
      case "--no-sandbox":
        config.noSandbox = true;
        break;
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--budget": {
        const v = parseFloat(next("--budget"));
        if (!Number.isFinite(v) || v <= 0) {
          throw new Error("--budget must be a positive number (USD)");
        }
        config.budgetUsd = v;
        break;
      }
      case "--auto-checkpoint": {
        const v = parseInt(next("--auto-checkpoint"), 10);
        if (!Number.isFinite(v) || v <= 0) {
          throw new Error("--auto-checkpoint must be a positive integer (turns)");
        }
        config.autoCheckpoint = v;
        break;
      }
      case "--no-web-search":
        config.noWebSearch = true;
        break;
      case "--no-memory":
        config.noMemory = true;
        break;
      case "--no-subagent":
        config.noSubagent = true;
        break;
      case "--no-skills":
        config.noSkills = true;
        break;
      case "--no-permissions":
        config.noPermissions = true;
        break;
      case "--no-context-edit":
        config.noContextEdit = true;
        break;
      case "--init":
        config.init = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return config;
}

export const HELP_TEXT = `Usage: arnie [options]

Options:
  --model <id>            Claude model ID (default: claude-opus-4-7)
  --effort <level>        Effort: low|medium|high|xhigh|max (default: xhigh)
  --max-tokens <n>        Max output tokens per turn (default: 64000)
  --no-thinking           Disable adaptive thinking
  --no-compact            Disable server-side context compaction
  --no-context-edit       Disable automatic clearing of stale tool outputs
  --no-web-search         Disable web search tool
  --no-subagent           Disable subagent (Haiku) tool
  --no-skills             Don't load .arnie/skills/*
  --no-memory             Don't load .arnie/memory.md
  --no-permissions        Ignore .arnie/permissions.json
  --no-hooks              Ignore .arnie/hooks.json
  --no-mcp                Ignore .arnie/mcp.json
  --no-status-line        Don't render the status line
  --no-markdown           Don't render markdown (raw output)
  -q, --quiet             Suppress tool execution chatter; only show responses
  --voice                 Speak assistant responses (espeak/say/PowerShell SAPI)
  --no-sandbox            Ignore .arnie/sandbox.json path restrictions
  --dry-run               Investigation only — mutating tools refuse
  --budget <usd>          Halt the session after exceeding $N in tokens
  --auto-checkpoint <n>   Auto-save the session every N user turns
  --no-transcript         Don't write a session transcript
  --transcript-dir <dir>  Directory for transcripts (default: ~/.arnie/transcripts)
  --no-usage              Don't display per-turn usage
  --system-extra <text>   Append text to the system prompt
  --resume [name]         Resume a saved session (most recent if no name)
  -p, --print <msg>       Run a single non-interactive turn and exit
  --init                  Scaffold .arnie/ directory in current cwd and exit
  --version               Print version and exit
  -h, --help              Show this help and exit

Input:
  Type a message and press Enter. Triple-quote (""") on its own line
  starts and ends multi-line mode for pasting logs and stack traces.

Slash commands inside the REPL:
  /help                       Show REPL help
  /usage                      Token totals and cost
  /usage tools                Per-tool call counts and durations
  /clear                      Reset the conversation
  /clear --summary            Reset, replacing history with a model-written summary
  /tools                      List available tools
  /save <name>                Save the conversation
  /load <name>                Load a saved conversation
  /list                       List saved sessions
  /find <query>               Search across saved sessions
  /export <name>              Export current conversation to markdown
  /memory                     Show loaded memory files
  /remember <fact>            Append a line to .arnie/memory.md
  /skills                     List discovered skills
  /settings                   Show current settings
  /settings <key> <value>     Set and persist a setting
  /jobs                       List background shell jobs
  /jobs --watch               Block until all background jobs finish
  /plan                       Toggle plan mode
  /cd <path>                  Change cwd
  /exit                       Quit

Input directives:
  attach <path>           Attach an image (jpg/png/gif/webp) or text file
                          to the message; can appear anywhere in the input.

Environment:
  ANTHROPIC_API_KEY       Required.
`;

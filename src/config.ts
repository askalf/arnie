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
  noWebSearch: boolean;
  noMemory: boolean;
  noSubagent: boolean;
  noSkills: boolean;
  noPermissions: boolean;
  noContextEdit: boolean;
  init: boolean;
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
  noWebSearch: false,
  noMemory: false,
  noSubagent: false,
  noSkills: false,
  noPermissions: false,
  noContextEdit: false,
  init: false,
};

const VALID_EFFORTS: Config["effort"][] = ["low", "medium", "high", "xhigh", "max"];

export function parseArgs(argv: string[]): Config {
  const config: Config = { ...DEFAULTS };
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
        config.resume = next("--resume");
        break;
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
  --no-transcript         Don't write a session transcript
  --transcript-dir <dir>  Directory for transcripts (default: ~/.arnie/transcripts)
  --no-usage              Don't display per-turn usage
  --system-extra <text>   Append text to the system prompt
  --resume <name>         Resume a saved session by name
  --init                  Scaffold .arnie/ directory in current cwd and exit
  --version               Print version and exit
  -h, --help              Show this help and exit

Input:
  Type a message and press Enter. Triple-quote (""") on its own line
  starts and ends multi-line mode for pasting logs and stack traces.

Slash commands inside the REPL:
  /help                   Show REPL help
  /usage                  Show session token totals and cost estimate
  /clear                  Reset the conversation
  /tools                  List available tools
  /save <name>            Save the current conversation
  /load <name>            Load a saved conversation (replaces current)
  /list                   List saved sessions
  /memory                 Show the contents of memory files in use
  /remember <fact>        Append a line to .arnie/memory.md
  /skills                 List discovered skills
  /jobs                   List running background shell jobs
  /cd <path>              Change cwd for shell-tool calls
  /exit                   Quit

Environment:
  ANTHROPIC_API_KEY       Required.
`;

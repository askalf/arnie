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
}

const DEFAULTS: Config = {
  model: "claude-opus-4-7",
  effort: "high",
  maxTokens: 16000,
  thinking: "adaptive",
  transcript: true,
  showUsage: true,
  showHelp: false,
  showVersion: false,
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
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return config;
}

export const HELP_TEXT = `Usage: arnie [options]

Options:
  --model <id>            Claude model ID (default: claude-opus-4-7)
  --effort <level>        Effort: low|medium|high|xhigh|max (default: high)
  --max-tokens <n>        Max output tokens per turn (default: 16000)
  --no-thinking           Disable adaptive thinking
  --no-transcript         Don't write a session transcript
  --transcript-dir <dir>  Directory for transcripts (default: ~/.arnie/transcripts)
  --no-usage              Don't display per-turn usage
  --system-extra <text>   Append text to the system prompt (machine-specific instructions)
  --version               Print version and exit
  -h, --help              Show this help and exit

Slash commands inside the REPL:
  /help                   Show REPL help
  /usage                  Show session token totals and cost estimate
  /clear                  Reset the conversation
  /tools                  List available tools
  /exit                   Quit

Environment:
  ANTHROPIC_API_KEY       Required.
`;

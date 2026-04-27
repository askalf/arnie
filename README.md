# arnie

A portable IT troubleshooting *companion* for the terminal. Like Claude Code, but specialized for diagnosing and fixing technical issues — networking, AD, Windows Update, package managers, log triage, hardware checks, dev environments — with a tool surface tuned for that work.

Built on the Anthropic SDK with `claude-opus-4-7`, adaptive thinking, server-side compaction, and prompt caching.

## Install

Requires Node.js 20+.

```sh
git clone <this repo> arnie
cd arnie
npm install
npm run build
npm link    # exposes `arnie` globally
```

Or run from the source tree without linking:

```sh
npm start
```

## Configure

Set your Anthropic API key:

```sh
# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...
```

## Use

```sh
arnie
```

Talk to it like a colleague. It will use its tools to investigate the actual machine before guessing.

```
you> the printer queue is jammed and i can't restart spooler
arnie> [investigates with shell + Get-Service, finds stuck job, proposes the fix]
```

### Multi-line input

Triple-quote (`"""`) on its own line starts and ends a multi-line block. Use this for pasting logs or stack traces:

```
you> """
[2026-04-27T18:42:01] ERROR: socket connect ECONNREFUSED 10.0.0.5:445
[2026-04-27T18:42:02] ERROR: tree connect failed: STATUS_BAD_NETWORK_NAME
"""
arnie> [reads the SMB error, investigates...]
```

### Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | Show REPL help |
| `/usage` | Show session token totals + estimated cost |
| `/clear` | Reset the conversation |
| `/tools` | List registered tools |
| `/jobs` | List background shell jobs |
| `/memory` | Show loaded memory files |
| `/save <name>` | Save the current conversation |
| `/load <name>` | Replace the current conversation with a saved one |
| `/list` | List saved sessions |
| `/exit` | Quit (or Ctrl+C twice) |

### Tools the model can use

| Tool | Purpose |
| --- | --- |
| `shell` | Run a foreground shell command (PowerShell on Windows, `/bin/sh` elsewhere). Destructive commands require user confirmation. |
| `shell_background` | Start a long-running command in the background; returns a `job_id` immediately. Use for `chkdsk`, `sfc /scannow`, package builds, log tails. |
| `shell_status` | Poll a background job's state and recent output. |
| `shell_kill` | Force-kill a background job. |
| `read_file` | Read a file (with optional line range, 200KB cap). |
| `write_file` | Write a file (always confirms; shows a content preview). |
| `list_dir` | List directory contents with type + size. |
| `grep` | Regex search across files (skips node_modules/.git/dist; supports glob, context lines, literal mode). |
| `web_search` | Server-side web search for KB articles, vendor docs, error string lookups. |

### Cross-session memory

If `.arnie/memory.md` exists in the current directory or `~/.arnie/memory.md` exists in your home directory, the contents are loaded into the system prompt at startup. Use it for stable, cross-session context — *"this network uses 10.0.0.0/8, AD DC is at 10.0.0.5, all servers run Server 2022"*. Cheaper than re-explaining it every session.

### Resume a previous conversation

```sh
arnie --resume printer-issue   # picks up where /save printer-issue left off
```

## Flags

```
--model <id>            Claude model (default: claude-opus-4-7)
--effort <level>        low | medium | high | xhigh | max  (default: xhigh)
--max-tokens <n>        Max output tokens per turn (default: 64000)
--no-thinking           Disable adaptive thinking
--no-compact            Disable server-side context compaction
--no-web-search         Don't expose web_search tool
--no-memory             Don't load .arnie/memory.md or ARNIE.md
--no-transcript         Don't write a session transcript
--transcript-dir <dir>  Transcript directory (default: ~/.arnie/transcripts)
--no-usage              Hide per-turn token/cost display
--system-extra <text>   Append text to the system prompt
--resume <name>         Resume a saved session by name
--version               Print version and exit
-h, --help              Show help
```

## What gets written to disk

| What | Where | Why |
| --- | --- | --- |
| Session transcripts | `~/.arnie/transcripts/<timestamp>.jsonl` | Debugging, audit trail, cost analysis |
| Saved conversations | `~/.arnie/sessions/<name>.json` | `/save` and `--resume` |
| Memory file | `.arnie/memory.md` (cwd) or `~/.arnie/memory.md` | Cross-session context loaded into the system prompt |

The `.arnie/` directory in cwd is gitignored by default if you check this repo out fresh.

## Safety

- Destructive shell commands (`rm -rf`, `Remove-Item`, `format`, `Stop-Service`, `shutdown`, registry edits, package removals, etc.) require explicit `[y/N]` confirmation before running. The same gating applies to background jobs.
- `write_file` always shows a preview and asks before overwriting.
- The model is told to call out risk before destructive steps and to ask for elevation when needed.
- First Ctrl+C cancels the in-flight model request; second Ctrl+C exits.

## Development

```sh
npm run dev          # tsx watch
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npx tsx src/test-tools.ts   # offline test suite (no API needed)
```

## License

MIT.

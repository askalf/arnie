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
| `/usage` | Session token totals + estimated cost. `/usage tools` for per-tool call counts and durations. |
| `/clear` | Reset the conversation. `/clear --summary` replaces history with a model-written summary instead of wiping it. |
| `/tools` | List registered tools |
| `/jobs` | List background shell jobs. `/jobs --watch` blocks until they all finish. |
| `/skills` | List discovered skills |
| `/memory` | Show loaded memory files |
| `/remember <fact>` | Append a dated line to `.arnie/memory.md` |
| `/cd <path>` | Change cwd mid-session |
| `/save <name>` | Save the current conversation |
| `/load <name>` | Replace the current conversation with a saved one |
| `/list` | List saved sessions |
| `/find <query>` | Search across saved sessions for a substring; shows session, message index, snippet |
| `/export <name>` | Export the current conversation as Markdown to `~/.arnie/exports/<name>.md` |
| `/replay <transcript.jsonl>` | Reconstruct the conversation from a transcript file |
| `/init` | Bootstrap a `.arnie/memory.md` for this machine — model probes the box and proposes one |
| `/settings` | Show effective settings. `/settings <key> <value>` sets and persists to `~/.arnie/settings.json`. |
| `/profile` | Show effective model + thinking/effort/budget profile |
| `/feedback "note"` | Append a dated note to `~/.arnie/feedback.md` (loaded into the system prompt next session). `/feedback --clear` empties it. |
| `/plan` | Toggle plan mode — model proposes a plan first and awaits approval before mutating tools |
| `/exit` (or `/quit`) | Quit (or Ctrl+C twice) |

### Tools the model can use

| Tool | Purpose |
| --- | --- |
| `shell` | Foreground shell command (PowerShell on Windows, `/bin/sh` elsewhere). Destructive commands require confirmation; commands matching `.arnie/permissions.json` allow rules can skip the prompt. |
| `shell_background` | Start a long-running command in the background; returns a `job_id` immediately. Use for `chkdsk`, `sfc /scannow`, package builds, log tails. |
| `shell_status` | Poll a background job's state and recent output. |
| `shell_kill` | Force-kill a background job. |
| `read_file` | Read a file (with optional line range, 200KB cap). |
| `write_file` | Write a file (always confirms; shows a content preview). |
| `edit_file` | String-replacement edit (always confirms; shows a diff preview). Prefer over write_file for partial changes. |
| `list_dir` | List directory contents with type + size. |
| `grep` | Regex search across files (skips node_modules/.git/dist; supports glob, context lines, literal mode). |
| `network_check` | Ping + optional TCP port probe. Cross-platform wrapper. |
| `service_check` | List Windows services / Linux systemd units with status. |
| `tail_log` | Last N lines of a file with optional regex filter — cheaper than `read_file` for large logs. |
| `process_check` | Cross-platform process listing (PID, name, CPU, memory) with name/pid filter and sort. |
| `disk_check` | Per-drive total/used/free GB and percent used (`Get-PSDrive` / `df`). |
| `apply_patch` | Apply a unified-diff patch (with `@@` hunk headers) to a file. Better than `edit_file` for 4+ changes in one file. Confirms with colored preview. |
| `monitor` | Run a shell command N times on an interval; only iterations where output changed are returned. Bounded (max 30 iters, max 60s apart). |
| `event_log` | Recent system events (Windows: `Get-WinEvent`; Linux: `journalctl`). Filter by level / source / time window. |
| `registry_read` | Windows registry inspection. Path must start with `HKLM`/`HKCU`/`HKCR`/`HKU`/`HKCC`. Reads values + immediate subkeys (or recursive). |
| `firewall_check` | Inspect host firewall state. Windows: `Get-NetFirewallProfile` + optional `Get-NetFirewallRule`. Linux: ufw → firewalld → iptables. macOS: `socketfilterfw`. Default returns just profile state; pass `rules=true` for the rule list (capped at 200). |
| `subagent` | Spawn a focused Haiku-backed read-only investigation. Delegate enumeration / summarization to keep the main loop cheap. |
| `web_search` | Server-side web search for KB articles, vendor docs, error string lookups. |

### Cross-session memory

Memory files are loaded into the system prompt at startup. Arnie checks three locations, in order, and merges them:

- `~/.arnie/memory.md` — global, all projects
- `.arnie/memory.md` — project-scoped (current cwd)
- `ARNIE.md` — project-scoped, top-level alias if you don't want a hidden `.arnie/` dir

Use it for stable, cross-session context — *"this network uses 10.0.0.0/8, AD DC is at 10.0.0.5, all servers run Server 2022"*. Cheaper than re-explaining it every session.

Append new facts on the fly with `/remember <fact>` — appends a dated line to `.arnie/memory.md`. Or run `/init` and let the model probe the machine and write one for you.

### Skills

Drop scoped expertise into `.arnie/skills/<name>/SKILL.md` (project) or `~/.arnie/skills/<name>/SKILL.md` (global). Each `SKILL.md` should start with frontmatter:

```yaml
---
name: active-directory
description: AD replication, group policy, FSMO roles. Use when the issue involves domain controllers or AD authentication.
---

# Active Directory playbook

...
```

The skill name and description are loaded into the system prompt at startup; the body is loaded on demand when the model decides it's relevant (it calls `read_file` with the skill path). This keeps the base system prompt small while making specialized knowledge discoverable.

### Permissions config

`.arnie/permissions.json` lets you pre-approve safe commands or block dangerous ones. Patterns are JS regexes matched against the full command string.

```json
{
  "allow": [
    { "pattern": "^Get-Service\\b", "reason": "read-only PS" }
  ],
  "deny": [
    { "pattern": "\\bformat\\s+[a-zA-Z]:", "reason": "no formatting drives, ever" }
  ]
}
```

Deny is checked first and refuses outright. Allow takes effect *after* the destructive-pattern detector triggers — it lets you skip the `[y/N]` for commands you trust.

### Resume a previous conversation

```sh
arnie --resume printer-issue   # picks up where /save printer-issue left off
```

### Initialize a workspace

```sh
arnie --init    # scaffolds .arnie/ with memory.md, permissions.json, an example skill
```

### Non-interactive single turn

```sh
arnie --print "diagnose disk i/o"     # one turn, prints response, exits
```

Useful for scripts, cron, or piping into other tools. All flags work the same — disable usage display, transcripts, etc., as needed.

### Settings file

`~/.arnie/settings.json` provides defaults that CLI flags override:

```json
{
  "model": "claude-opus-4-7",
  "effort": "xhigh",
  "maxTokens": 64000,
  "compact": true,
  "subagent": true,
  "memory": true,
  "skills": true,
  "permissions": true,
  "statusLine": true,
  "markdown": true
}
```

### MCP servers

Connect remote MCP servers via `~/.arnie/mcp.json` (or `.arnie/mcp.json` per project):

```json
{
  "servers": [
    {
      "type": "url",
      "name": "github",
      "url": "https://api.githubcopilot.com/mcp/",
      "authorization_token": "ghp_..."
    }
  ]
}
```

Servers are passed through to the API's `mcp_servers` parameter; tool discovery, auth, and execution happen on Anthropic's side.

### Image and file attachments

Inside a user message, you can attach files four ways:

- `@path/to/file` — bare-token reference, like Claude Code. Auto-attaches if the file exists.
- `@path/with/*.glob` — auto-attach every file matching the glob (e.g. `@src/**/*.ts`).
- `attach <path>` — explicit form, useful if the path contains spaces or unusual characters.
- `@<url>` — fetch a `http://` or `https://` URL and attach the body. Image content-types become image blocks; everything else is treated as text. Capped at 2MB and 15s.

Supported images: jpg/png/gif/webp (max 8MB). Other files are read as text (max 200KB).

```
you> what's this dialog box telling me? @C:\Users\me\Desktop\error.png
you> review @src/auth.ts and look for issues
you> any obvious smells in @src/**/*.ts ?
```

### Output redactors

Secrets in shell output get scrubbed before the model ever sees them. Defaults catch Anthropic API keys, AWS keys, GitHub PATs, Bearer tokens, password/api_key assignments. Add your own in `~/.arnie/redactors.json`:

```json
{
  "defaults": true,
  "rules": [
    { "pattern": "internal-prod-token-[A-Z0-9]+", "replacement": "[REDACTED:internal]" },
    { "pattern": "(?i)pin\\s*[:=]\\s*\\d+", "replacement": "pin=[REDACTED]" }
  ]
}
```

Set `"defaults": false` to use only your custom rules. Patterns are JS regexes.

### Persona override

`~/.arnie/persona.md` (or `.arnie/persona.md` per project) appends to the system prompt. Use this to flavor or specialize arnie — e.g., make it a database admin assistant for one project, a Windows-server SME for another.

### Sandbox

`.arnie/sandbox.json` constrains which paths the file tools can touch. Empty or missing config = no restrictions.

```json
{
  "allowed_read_paths": ["~/projects/foo", "/var/log"],
  "allowed_write_paths": ["~/projects/foo"]
}
```

`read_file`, `list_dir`, `write_file`, and `edit_file` all consult this. Paths outside the allowed dirs return a `sandbox denied` error to the model so it can adapt.

### Dry-run mode

`--dry-run` flips the harness into investigation-only mode: read tools (read_file, list_dir, grep, network_check, service_check, tail_log, process_check, disk_check, web_search, subagent) work normally, but mutating tools (shell, shell_background, write_file, edit_file, apply_patch) refuse and return a message telling the model what they'd have done. The model then reports back to you in plain English instead of acting. The status line shows `[dry-run]`.

```sh
arnie --dry-run
```

### Cost budget

`--budget 5.00` halts the session when the running cost exceeds $5.00. Useful for unattended runs.

In `--print` mode (one-shot), the request has already executed by the time the budget is checked, so it can't pre-empt the spend. Instead arnie warns to stderr and exits with a non-zero status, so cron/script wrappers can react:

```sh
arnie --budget 0.05 --print "diagnose disk i/o" || echo "spent more than 5¢"
```

### Auto-checkpoint

`--auto-checkpoint 10` saves the session every 10 user turns under a name like `checkpoint-2026-04-27T21-25-13`. Resume the most recent with `arnie --resume`.

### Background-job notifications

When a `shell_background` job finishes between turns, the next user message is automatically prefixed with a `<system-reminder>` listing the finished jobs (id, command, exit code, elapsed). The model can then call `shell_status` to read the output.

### Replay & feedback

- `/replay <transcript.jsonl>` reconstructs the conversation from a transcript file (handy for resuming a debugging session that wasn't `/save`d).
- `/feedback "note"` appends a dated note to `~/.arnie/feedback.md`. On the next session start, that file's contents get loaded into the system prompt — durable lessons across runs. `/feedback --clear` empties it.

### Use with dario (Claude Max subscription / multi-provider)

[dario](https://github.com/askalf/dario) is a local LLM router that exposes one Anthropic-compatible endpoint at `http://localhost:3456` and routes requests to your Claude Max subscription (via OAuth, no per-token API billing) or to any of OpenAI / Groq / OpenRouter / Ollama / LiteLLM as a backend.

arnie speaks to it directly — set the base URL and you're done:

```sh
# install + log in once
npm install -g @askalf/dario
dario login
dario proxy &

# point arnie at it
arnie --dario        # short form: sets http://localhost:3456 + dummy key
# or
arnie --base-url http://localhost:3456
# or
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario arnie
```

When `--dario` is on, the banner shows `base url: http://localhost:3456 (via --dario)`. Everything else — tools, slash commands, sessions, memory — is unchanged. Switch backends in dario by changing the model name passed via `--model`.

### Spillover output

When a shell command produces more than 100KB of output, the truncated portion goes to disk under the OS temp dir, and the path is returned in `stdout_full_path`/`stderr_full_path`. The model can read it back via `read_file` to inspect specific portions without flooding the context.

### Hooks

`~/.arnie/hooks.json` (or `.arnie/hooks.json` in the project) runs shell commands when tools execute. Each hook list runs in parallel; per-command 5s timeout; failures are silent (best-effort).

```json
{
  "before_tool": [
    "echo \"$ARNIE_TOOL_NAME starting at $(date -Iseconds)\" >> /tmp/arnie-tools.log"
  ],
  "after_tool": [
    "echo \"$ARNIE_TOOL_NAME finished\" >> /tmp/arnie-tools.log"
  ],
  "on_error": [
    "logger -t arnie \"$ARNIE_TOOL_NAME failed: $ARNIE_TOOL_ERROR\""
  ]
}
```

Available env vars in hook commands: `ARNIE_TOOL_NAME`, `ARNIE_TOOL_INPUT` (JSON, capped at 4KB), `ARNIE_TOOL_RESULT` (JSON, capped at 4KB), `ARNIE_TOOL_ERROR`.

## Flags

```
--model <id>            Claude model (default: claude-opus-4-7)
--effort <level>        low | medium | high | xhigh | max  (default: xhigh)
--max-tokens <n>        Max output tokens per turn (default: 64000)
--no-thinking           Disable adaptive thinking
--no-compact            Disable server-side context compaction
--no-context-edit       Disable automatic clearing of stale tool outputs
--no-web-search         Don't expose web_search tool
--no-subagent           Don't expose subagent tool
--no-skills             Don't load .arnie/skills/*
--no-memory             Don't load .arnie/memory.md or ARNIE.md
--no-permissions        Ignore .arnie/permissions.json
--no-hooks              Ignore .arnie/hooks.json
--no-mcp                Ignore .arnie/mcp.json (skip remote MCP servers)
--no-sandbox            Ignore .arnie/sandbox.json path restrictions
--no-status-line        Don't render the status line
--no-markdown           Don't render markdown (raw output)
--no-transcript         Don't write a session transcript
--transcript-dir <dir>  Transcript directory (default: ~/.arnie/transcripts)
--no-usage              Hide per-turn token/cost display
-q, --quiet             Suppress tool execution chatter; only show responses
--voice                 Speak assistant responses (espeak / `say` / PowerShell SAPI)
--system-extra <text>   Append text to the system prompt
--dry-run               Investigation only — mutating tools refuse
--budget <usd>          Halt the session after exceeding $N in tokens
                        (in --print mode: warn + exit non-zero, can't pre-empt)
--auto-checkpoint <n>   Auto-save the session every N user turns
--base-url <url>        Anthropic-compat endpoint (overrides ANTHROPIC_BASE_URL)
--dario                 Route through a local dario proxy at http://localhost:3456
                        (sets base URL + dummy API key if not already set)
--resume [name]         Resume a saved session (most recent if no name)
-p, --print <msg>       Run a single non-interactive turn and exit
--init                  Scaffold .arnie/ in current cwd and exit
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

## Notes

### Paths on Windows under MSYS / Git Bash

If you're running arnie from MSYS bash, Cygwin, or Git Bash on Windows, paste **Windows-shaped paths** into prompts (`C:/Users/you/...` or `C:\Users\you\...`), not Unix-shaped ones. Bash's `/tmp` aliases to `%LOCALAPPDATA%\Temp` for the shell, but arnie runs as a Node process and resolves the literal string `/tmp` to `C:\tmp` — which doesn't exist. PowerShell, cmd.exe, and WSL are unaffected.

## Development

```sh
npm run dev               # tsx watch
npm run typecheck         # tsc --noEmit
npm run build             # tsc → dist/
npm test                  # offline tool unit tests (no API key needed)
npm run test:integration  # full end-to-end against dario (skips if no backend)
```

`npm run test:integration` exercises the real arnie binary through every major tool, both file-mutation paths, mode flags, and the `--budget` regression. It looks for a dario proxy at `http://localhost:3456` by default; pass `--direct` to use `ANTHROPIC_API_KEY` instead. If neither backend is reachable, it exits 0 with `[SKIP]` so it's safe in CI.

## License

MIT.

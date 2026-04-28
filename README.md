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
| `/skills` | List discovered skills |
| `/memory` | Show loaded memory files |
| `/remember <fact>` | Append a dated line to `.arnie/memory.md` |
| `/cd <path>` | Change cwd mid-session |
| `/save <name>` | Save the current conversation |
| `/load <name>` | Replace the current conversation with a saved one |
| `/list` | List saved sessions |
| `/export <name>` | Export the current conversation as Markdown to `~/.arnie/exports/<name>.md` |
| `/plan` | Toggle plan mode — model proposes a plan first and awaits approval before mutating tools |
| `/exit` | Quit (or Ctrl+C twice) |

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
| `subagent` | Spawn a focused Haiku-backed read-only investigation. Delegate enumeration / summarization to keep the main loop cheap. |
| `web_search` | Server-side web search for KB articles, vendor docs, error string lookups. |

### Cross-session memory

If `.arnie/memory.md` exists in the current directory or `~/.arnie/memory.md` exists in your home directory, the contents are loaded into the system prompt at startup. Use it for stable, cross-session context — *"this network uses 10.0.0.0/8, AD DC is at 10.0.0.5, all servers run Server 2022"*. Cheaper than re-explaining it every session.

Append new facts on the fly with `/remember <fact>` — appends a dated line to `.arnie/memory.md`.

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

Inside a user message, you can attach files two ways:

- `@path/to/file` — bare-token reference, like Claude Code. Auto-attaches if the file exists.
- `attach <path>` — explicit form, useful if the path contains spaces or unusual characters.

Supported images: jpg/png/gif/webp (max 8MB). Other files are read as text (max 200KB).

```
you> what's this dialog box telling me? @C:\Users\me\Desktop\error.png
you> review @src/auth.ts and look for issues
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

### Cost budget

`--budget 5.00` halts the session when the running cost exceeds $5.00. Useful for unattended runs.

### Auto-checkpoint

`--auto-checkpoint 10` saves the session every 10 user turns under a name like `checkpoint-2026-04-27T21-25-13`. Resume the most recent with `arnie --resume`.

### Background-job notifications

When a `shell_background` job finishes between turns, the next user message is automatically prefixed with a `<system-reminder>` listing the finished jobs (id, command, exit code, elapsed). The model can then call `shell_status` to read the output.

### Replay & feedback

- `/replay <transcript.jsonl>` reconstructs the conversation from a transcript file (handy for resuming a debugging session that wasn't `/save`d).
- `/feedback "note"` appends a dated note to `~/.arnie/feedback.md`. On the next session start, that file's contents get loaded into the system prompt — durable lessons across runs. `/feedback --clear` empties it.

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
--no-status-line        Don't render the status line
--no-markdown           Don't render markdown (raw output)
--no-transcript         Don't write a session transcript
--transcript-dir <dir>  Transcript directory (default: ~/.arnie/transcripts)
--no-usage              Hide per-turn token/cost display
--system-extra <text>   Append text to the system prompt
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

## Development

```sh
npm run dev          # tsx watch
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npx tsx src/test-tools.ts   # offline test suite (no API needed)
```

## License

MIT.

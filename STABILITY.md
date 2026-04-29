# Stability Policy

Arnie is a CLI agent. Its public surface is the user-facing contract: documented CLI flags (`arnie --help`), documented slash commands (`/help`), tool definitions visible to the model (`/tools`), config file shapes (`.arnie/permissions.json`, `.arnie/sandbox.json`, `.arnie/skills/`, `.arnie/hooks.json`, `.arnie/mcp.json`, `~/.arnie/settings.json`, `~/.arnie/redactors.json`), and on-disk artifacts (transcript JSONL shape, saved-session JSON shape).

This document defines what's stable, what isn't, and how deprecations are handled.

If anything in this document is unclear or a specific surface's tier isn't visible, [open an issue](https://github.com/askalf/arnie/issues/new) — ambiguity in stability claims is a bug.

## Stability tiers

### `@stable`

- **Contract:** does not break without a major-version bump and at least one minor-version deprecation cycle.
- **Use:** wire into scripts, cron jobs, CI pipelines, automation; rely on slash-command names, file shapes, exit codes.
- **Examples (at v1.x):**
  - **CLI flags:** `--model`, `--effort`, `--max-tokens`, `--no-thinking`, `--no-compact`, `--no-context-edit`, `--no-web-search`, `--no-subagent`, `--no-skills`, `--no-memory`, `--no-permissions`, `--no-hooks`, `--no-mcp`, `--no-sandbox`, `--no-status-line`, `--no-markdown`, `--no-transcript`, `--transcript-dir`, `--no-usage`, `-q`/`--quiet`, `--system-extra`, `--dry-run`, `--budget`, `--auto-checkpoint`, `--base-url`, `--dario`, `--resume`, `-p`/`--print`, `--init`, `--version`, `-h`/`--help`
  - **Slash commands:** `/help`, `/usage`, `/clear`, `/tools`, `/jobs`, `/skills`, `/memory`, `/remember`, `/cd`, `/save`, `/load`, `/list`, `/find`, `/export`, `/replay`, `/init`, `/settings`, `/profile`, `/feedback`, `/plan`, `/exit`, `/quit`
  - **Tool names:** `shell`, `shell_background`, `shell_status`, `shell_kill`, `read_file`, `write_file`, `edit_file`, `apply_patch`, `list_dir`, `grep`, `network_check`, `service_check`, `tail_log`, `process_check`, `disk_check`, `monitor`, `event_log`, `registry_read`, `firewall_check`, `subagent`, `web_search`
  - **Config files:** the schemas of `.arnie/permissions.json`, `.arnie/sandbox.json`, `.arnie/hooks.json`, `.arnie/mcp.json`, `~/.arnie/settings.json`, `~/.arnie/redactors.json`
  - **Memory files:** the load order and content semantics of `~/.arnie/memory.md`, `.arnie/memory.md`, `ARNIE.md`
  - **`@<path>`/`@<glob>`/`@<url>` attachment syntax** in user input
  - **Exit codes:** 0 on success; 1 when `--budget` is exceeded in `--print` mode; 2 on argument-parse error
  - **Env vars** as inputs: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`

### `@experimental`

- **Contract:** can change or be removed in any minor release with a short notice when practical, but no guarantees.
- **Use:** evaluate, prototype against, give feedback before they stabilize.
- **Examples (at v1.x):** none currently. New flags introduced after v1.1 default to `@experimental` for at least one minor cycle before being promoted.

### `@deprecated`

- **Contract:** will be removed in the next major release. Stays functional with a runtime warning (logged once per process) pointing at the replacement.
- **Use:** migrate away.
- **Examples (at v1.x):** none currently.

### Internal

Anything not documented in `arnie --help`, the README's slash-command table, the README's tool table, or this document is **internal** — free to change without notice. This includes tool *parameter shapes* exposed to the model (those evolve as we tune what the model sees); **tool names** are stable, but the JSON schema of a tool's input may gain or rename fields between minor versions.

## Deprecation cycle

When a `@stable` surface needs to go away:

1. Next minor release: mark it `@deprecated` and add a runtime one-shot `console.warn` pointing at the replacement. Note in `CHANGELOG.md` under `### Deprecated`.
2. Subsequent releases keep it functional and warning.
3. Next major release: remove it. Migration path documented in the major's release notes.

Minimum time from `@deprecated` to removal: **one minor release + one major release cycle**. Never less than 30 days in any circumstance.

For CLI flags specifically: the flag stays accepted (ignored, if behavior was removed) through one extra major release beyond the deprecation so shell scripts don't break silently.

## What arnie will never do without a major bump

- Rename or remove a `@stable` CLI flag, slash command, or tool.
- Change the shape of a `@stable` config file's top-level keys without accepting the old shape for one major.
- Change the shape of saved sessions or transcripts in a way that breaks `--resume` / `/load` / `/replay` against existing artifacts.
- Change a documented exit code's meaning.
- Remove an env var without accepting the old name for one major.

## Release cadence

- **Patch (`1.1.x`):** bug fixes, doc updates, dependency bumps, test improvements. Ship as needed.
- **Minor (`1.2.0`):** new flags, new slash commands, new tools, new config-file fields. Always carries a `### Added` or `### Changed` CHANGELOG entry.
- **Major (`2.0.0`):** removes `@deprecated` surfaces, changes `@stable` behavior, ships breaking changes. Always carries a migration note.

## Reporting a stability incident

If a `@stable` surface breaks without a deprecation cycle, that's a bug — [open an issue tagged `stability-regression`](https://github.com/askalf/arnie/issues/new) and we'll treat it as a patch-release priority.

## History

- **v1.1.2:** stability policy formalized; v1 surface enumerated in `@stable`.

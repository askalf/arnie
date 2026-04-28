# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

## [1.1.2] - 2026-04-28

Metadata-only release. The first publish of `arnie-cli` to npm went out without `repository` / `homepage` / `bugs` / `license` / `author` / `keywords` fields, so the npm registry page had no GitHub link and search ranking was weak. Filled all of those in. No code changes; behavior identical to 1.1.1.

The repo was also flipped from private to public alongside this release.

## [1.1.1] - 2026-04-28

Fix for `--budget` being silently ignored in `--print` mode.

`runPrintMode` bypassed the budget check (it lived in the REPL loop only), so unattended `arnie --budget X --print "..."` calls would happily spend past the cap with no warning and exit 0. Single-turn print mode can't *prevent* the spend after the request fires, but it can warn to stderr and exit non-zero so cron/script wrappers can react. Found while in-depth-testing arnie-via-dario.

README also brought current with the actual code surface — `/find`, `/init`, `/settings`, `/profile`, `/feedback`, `/replay` slash commands were undocumented; `--no-mcp`, `--no-sandbox`, `-q/--quiet`, `--voice` flags were missing from the cheatsheet; cross-session memory section didn't list all three load paths (`~/.arnie/memory.md`, `.arnie/memory.md`, `ARNIE.md`); `@<glob>` attachment form wasn't mentioned.

Plus an integration test suite (`npm run test:integration`) that exercises the real arnie binary end-to-end through every read tool, both file-mutation paths, mode flags, and a regression for this fix. Skips cleanly if neither dario nor `ANTHROPIC_API_KEY` is reachable.

## [1.1.0] - 2026-04-28

`--dario` and `--base-url` for routing through [dario](https://github.com/askalf/dario), the local LLM router.

`--dario` is a short-form sets `ANTHROPIC_BASE_URL=http://localhost:3456` plus a dummy API key if neither is already exported, so users don't have to remember both. `--base-url` is the explicit form for any Anthropic-compatible endpoint. Banner shows `base url: http://... (via --dario)` so it's clear the request isn't going to api.anthropic.com directly. All tools, slash commands, sessions, and memory continue to work unchanged because dario terminates as an Anthropic-shaped endpoint.

## [1.0.0] - 2026-04-28

Initial public release. IT troubleshooting agent for the terminal with 21 tools (shell, shell_background/status/kill, read/write/edit_file, apply_patch, list_dir, grep, network_check, service_check, tail_log, process_check, disk_check, monitor, event_log, registry_read, firewall_check, subagent, web_search), confirm-gated mutations, dry-run mode, plan mode, sandbox + permissions config, hooks, output redactors, sessions (`/save` / `--resume`), memory files (`.arnie/memory.md` / `ARNIE.md` / `~/.arnie/memory.md`), skills, persona override, transcripts, MCP server support, image and `@<glob>` attachments, cost budget, and auto-checkpoints.

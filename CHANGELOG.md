# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

Distribution polish + skill pack + remote/ssh tools.

`docs/EXAMPLES.md` adds five worked troubleshooting flows (printer spooler hung, "disk full but du disagrees", mis-routed TCP, AD trust break, CrashLoopBackOff with empty logs) so a new user can see what an arnie session actually looks like without running it.

`skills/` ships a starter skill pack at the repo root: `active-directory`, `windows-update`, `systemd`, `kubernetes-pod-triage`, `smb-shares`, `ssh-remote-triage`. Each is a self-contained `SKILL.md` users can copy into `~/.arnie/skills/` to install. Addresses the "feature-rich but unknown" gap — arnie has had skill loading since 1.0.0 but nothing for users to actually load on day one. README points at both.

Three new tools — `ssh_exec`, `scp_get`, `ssh_hosts` — close the long-standing gap that arnie could only troubleshoot the local box. Real sysadmin work happens against servers the user *isn't sitting at*; now arnie can hit them directly.

- `ssh_exec`: run a command on a remote via the system `ssh` binary (so `~/.ssh/config`, agent keys, ProxyJump, known_hosts all work). Uses `BatchMode=yes` + `ConnectTimeout=10` so it fails fast instead of hanging on auth prompts. Same destructive-pattern detector + confirmation as local `shell` — `ssh box rm -rf /` is just as bad. Same redactors. Same 100 KB spillover. Distinguishes ssh-itself failures (exit 255) from remote-command failures so the model doesn't waste time debugging a connection that never landed.
- `scp_get`: pull a remote file to a local temp path, return the path. Pairs with `read_file` / `grep` for cheap re-reads without ssh round-trips. Sandbox write rules apply if `local_path` is specified.
- `ssh_hosts`: list aliases from `~/.ssh/config` (and `/etc/ssh/ssh_config` on non-Windows). Read-only; lets the model discover hosts without asking. Wildcards and `Match` blocks are skipped; `Include` directives aren't followed.

Both `ssh_exec` and `scp_get` are treated as mutating in `--dry-run`. `ssh_hosts` runs freely. Refactored `shell.ts` to export `looksDestructive`, `truncateOutput`, `spillover`, and `SPILLOVER_THRESHOLD_BYTES` so the ssh tool reuses the same destructive-detection and output-handling rather than drifting.

## [1.1.3] - 2026-04-28

`npm run test:integration` now picks the backend automatically — dario if it's reachable, direct API if `ANTHROPIC_API_KEY` is set, otherwise skip. Previously it required `--direct` to be passed explicitly to use the API mode, which was awkward in CI environments with a key configured but no dario running. Existing `--direct` and `--dario` flags still work and now mean "require this mode, don't auto-fall-back" so scripts that depend on a specific backend stay deterministic.

This is also the first release shipped through the auto-release workflow added in 1.1.2 — version bump on master triggers tag, GitHub release, and `npm publish --provenance` automatically. From here on, releases are a single commit.

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

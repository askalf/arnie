# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in arnie, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@askalf.org** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. **Response SLA:** Acknowledgment within 48 hours, fix within 7 days for critical issues.
4. We will coordinate disclosure with you before publishing a fix.

## Scope

The following are in scope for security reports:

- **Confirmation bypass** — any path that lets the model execute a destructive shell command, write to a file, or apply a patch without the `[y/N]` prompt firing.
- **Sandbox escape** — `read_file` / `list_dir` / `write_file` / `edit_file` reaching paths outside `.arnie/sandbox.json`'s allowed list when sandbox is configured.
- **Permissions parser issues** — `.arnie/permissions.json` regex evaluation that allows a denied pattern through.
- **Secret leakage** — output redactors failing to scrub `ANTHROPIC_API_KEY`, AWS keys, GitHub PATs, Bearer tokens, or other matched-by-default patterns before the model sees the output.
- **Spillover file disclosure** — `arnie-spillover-*` files in the OS temp dir created with weak permissions or predictable names that another local user could read or hijack.
- **Hooks abuse** — `~/.arnie/hooks.json` execution accepting tool input (`ARNIE_TOOL_INPUT`) that lets an attacker break out of the hook command into the user's shell.
- **MCP server trust** — accepting MCP server output blindly when the configured server is malicious or compromised, in ways that violate documented assumptions.
- **Path traversal in attachments** — `@<path>` / `attach <path>` reaching files outside any sandbox restriction.

## Out of Scope

- The model itself making bad calls (this is an agent — the user is the human-in-the-loop). Bugs in *what* the model decides to do are not security issues; bugs in arnie's gates around what it's *allowed* to do, are.
- Vulnerabilities in upstream dependencies (`@anthropic-ai/sdk`, `chalk`, `zod`) — please report those to their respective projects. We track upstream advisories via Dependabot.
- Sandbox escape when `.arnie/sandbox.json` is not configured (no sandbox = no constraint to escape).

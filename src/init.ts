import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

const MEMORY_TEMPLATE = `# Arnie memory

Stable, cross-session context goes here. Arnie loads this into its system
prompt at startup. Keep it short and factual.

## Machine

- Hostname: <fill in>
- OS: <fill in>
- Notable installed software: <fill in>

## Network

- Subnet: <fill in>
- DNS: <fill in>
- Gateway: <fill in>

## Conventions

- (e.g.) "All log files live under D:\\logs\\"
- (e.g.) "Service accounts use the prefix svc-"
`;

const PERMISSIONS_TEMPLATE = `{
  "_comment": "Pre-approve safe commands (allow) or block dangerous ones (deny). Patterns are JS regexes matched against the full command string. Allow takes effect after a destructive flag is detected; deny is checked first and refuses outright.",
  "allow": [
    { "pattern": "^Get-Service\\\\b", "reason": "read-only PowerShell" },
    { "pattern": "^Get-Process\\\\b", "reason": "read-only PowerShell" },
    { "pattern": "^Test-NetConnection\\\\b", "reason": "read-only network probe" }
  ],
  "deny": [
    { "pattern": "\\\\bformat\\\\s+[a-zA-Z]:", "reason": "no formatting drives, ever" }
  ]
}
`;

const SKILL_TEMPLATE = `---
name: example-skill
description: Replace this with a one-liner describing when this skill applies. Arnie reads SKILL.md on demand when relevant.
---

# Example skill

Put scoped expertise here — playbooks, common diagnostic flows, organization
conventions. Anything specialized that doesn't belong in the general system
prompt.

## When to use

- (e.g.) When the user is troubleshooting Active Directory replication.

## Steps

1. Check this first.
2. Then this.
3. If still broken, escalate.
`;

const GITIGNORE_TEMPLATE = `# Arnie writes per-session state here that you usually don't want to commit.
sessions/
transcripts/
`;

interface InitResult {
  created: string[];
  skipped: string[];
}

async function writeIfMissing(file: string, content: string, result: InitResult): Promise<void> {
  try {
    await fs.access(file);
    result.skipped.push(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    result.created.push(file);
  }
}

export async function initWorkspace(cwd: string = process.cwd()): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [] };
  const root = path.join(cwd, ".arnie");

  await writeIfMissing(path.join(root, "memory.md"), MEMORY_TEMPLATE, result);
  await writeIfMissing(path.join(root, "permissions.json"), PERMISSIONS_TEMPLATE, result);
  await writeIfMissing(path.join(root, "skills", "example-skill", "SKILL.md"), SKILL_TEMPLATE, result);
  await writeIfMissing(path.join(root, ".gitignore"), GITIGNORE_TEMPLATE, result);

  console.log(chalk.bold("arnie init"));
  for (const f of result.created) console.log(chalk.green(`  created  ${f}`));
  for (const f of result.skipped) console.log(chalk.dim(`  skipped  ${f} (already exists)`));
  if (result.created.length > 0) {
    console.log();
    console.log("Edit memory.md with stable facts about this machine/network.");
    console.log("Tweak permissions.json to pre-approve safe commands.");
    console.log("Drop skill folders under .arnie/skills/<name>/SKILL.md to add scoped expertise.");
  }
  return result;
}

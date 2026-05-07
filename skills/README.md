# Arnie skill pack

Ready-made skills you can drop into your arnie install. Each subdirectory is a self-contained skill — a `SKILL.md` with frontmatter (name + description) and a body of scoped expertise that arnie loads on demand when relevant.

## What's here

| Skill | Use when |
| --- | --- |
| `active-directory` | Domain-controller issues, replication, GPO, Kerberos, secure-channel breaks |
| `windows-update` | Windows Update stuck, `0x80...` error codes, WSUS misconfig, component-store corruption |
| `systemd` | Linux units failing, restart loops, dependency cycles, timers |
| `kubernetes-pod-triage` | Pods in CrashLoopBackOff, ImagePullBackOff, Pending, OOMKilled |
| `smb-shares` | UNC paths failing, NTLM/Kerberos auth, SMB negotiation, share ACLs |

## Install

Copy whichever skills you want into your global skill dir:

```sh
# macOS / Linux
mkdir -p ~/.arnie/skills
cp -r skills/active-directory skills/systemd ~/.arnie/skills/

# Windows (PowerShell)
New-Item -ItemType Directory -Force "$HOME\.arnie\skills"
Copy-Item -Recurse skills\active-directory, skills\windows-update "$HOME\.arnie\skills\"
```

Or, for a single project, copy into `.arnie/skills/` in the project root instead.

Then start arnie and run `/skills` — the installed ones should appear in the list. The skill **name + description** is loaded into the system prompt at startup; the **body** is loaded on demand when arnie decides it's relevant (it calls `read_file` on the skill path). Keeps the base prompt small while making specialized knowledge discoverable.

## How skill loading works

Arnie merges skills from three locations (in order):

1. `~/.arnie/skills/<name>/SKILL.md` — global, applies everywhere
2. `.arnie/skills/<name>/SKILL.md` — project-scoped, only when run from that directory

A skill is just a Markdown file. The frontmatter is required:

```yaml
---
name: my-skill
description: One-liner describing when this skill applies. Arnie reads this verbatim — write it like a search query the model will match against.
---

# My skill

Body content...
```

The description is what the model sees by default — make it specific. Bad: *"Linux stuff."* Good: *"Linux systemd troubleshooting — failed units, restart loops, journalctl triage. Use when the user mentions systemctl or a failed service."*

## Customize before you ship

These skills are starting points. You'll get more value if you edit them with environment-specific facts before installing:

- AD: hostnames of your DCs, FSMO holders, your domain's Kerberos realm
- Windows Update: your WSUS server hostname/port, approved-update cadence
- systemd: which units are critical for your fleet
- k8s: your cluster context names, common namespace conventions
- SMB: file-server hostnames, share-name conventions

Skills compose with `~/.arnie/memory.md` (machine-wide stable facts) and `.arnie/memory.md` (project-scoped). Use memory for facts that always apply; use skills for procedural playbooks that load only when relevant.

## Contributing a skill

PRs welcome. A good skill:

- Has a sharp, query-shaped description (the model has to *match* against it).
- Lists triage steps in order, with the cheapest checks first.
- Names actual commands, error codes, and event sources — not generic advice.
- Has a "Don't" section. Knowing what *not* to do is half the value.
- Stays under ~200 lines. If it's longer, split it.

---
name: ssh-remote-triage
description: Troubleshooting a remote server over ssh — running diagnostics, pulling logs, and reading state on a host the user is *not* sitting at. Use when the user mentions a hostname they want investigated, references "the server" or "prod-N", or pastes ssh output. Prefer `ssh_exec` / `scp_get` / `ssh_hosts` over asking the user to run commands manually.
---

# Remote triage playbook

When the user is at a workstation and the box with the problem is somewhere else.

## Discover before guessing

Call `ssh_hosts` first if you don't know which alias to use. It reads `~/.ssh/config` and returns alias / hostname / user / port. Don't ask the user "what's the host?" if `ssh_hosts` would have answered.

## Connection-layer failures (ssh exit 255)

`ssh_exec` returns `exit_code: 255` when ssh itself failed before the remote command ran. The stderr will include a hint, but the common causes:

- **No key in agent**: `ssh-add -l` locally; key not loaded → `BatchMode=yes` rejects password fallback.
- **Host unreachable**: confirm with `network_check` to port 22.
- **Host key changed**: stderr says `REMOTE HOST IDENTIFICATION HAS CHANGED`. Don't auto-accept — surface to the user. Could be reinstall, could be MITM.
- **Permission denied (publickey)**: key not authorized on remote, or wrong username. Check `~/.ssh/config` for the alias.

Don't loop retries on 255 — fix the root cause.

## Run-then-pull pattern

For anything bigger than a few KB, prefer:

1. `ssh_exec host "journalctl -u nginx -n 5000 > /tmp/nginx.log"` — generate it remotely
2. `scp_get host /tmp/nginx.log` — fetch to local temp
3. `read_file` / `grep` / `tail_log` on the local copy

Why not just `ssh_exec host "journalctl ..."` and read the output? Because the local tools are cheaper, support filtering and context, and you can re-read without spending another ssh round-trip. The 100 KB output cap on `ssh_exec` will truncate big logs.

## Multi-host enumeration

Use `subagent` for "check disk on every host in the inventory" — it's read-only, bounded, and keeps the main loop's context clean. Pattern:

```
subagent: "Run `df -h /` via ssh_exec on each of these hosts: web-01, web-02, db-01.
Return a markdown table of host, mount, used %, free GB. Flag any over 85%."
```

## Don't

- Don't run destructive commands without confirmation just because they're remote — the destructive-pattern detector applies to ssh_exec the same way it does to local shell.
- Don't paste secrets into commands that get stored in remote shell history. Use `ssh_exec host "command"` with the secret in the local env, not in the command string.
- Don't `ssh_exec host "sudo ..."` and expect a password prompt — `BatchMode=yes` means there's no TTY. Use NOPASSWD sudo for the specific command, or have the user pre-elevate.
- Don't tail-follow a remote log via ssh_exec (it'll just hit the timeout). Pull a snapshot with scp_get, or have the user `shell_background` an ssh that writes to a local file.

## Common one-liners

| Goal | Command |
| --- | --- |
| What kernel is it? | `ssh_exec host "uname -a"` |
| What's eating CPU? | `ssh_exec host "ps -eo pid,pcpu,pmem,comm --sort=-pcpu \| head -20"` |
| Is the disk full? | `ssh_exec host "df -h"` |
| Recent OOM kills? | `ssh_exec host "dmesg -T \| grep -i 'killed process' \| tail -20"` |
| What's listening? | `ssh_exec host "ss -tlnp"` |
| Recent journal errors | `ssh_exec host "journalctl -p err --since '1 hour ago' --no-pager \| tail -100"` |
| Pull /etc/foo.conf | `scp_get host /etc/foo.conf` then `read_file` |
| Service status | `ssh_exec host "systemctl status nginx --no-pager"` |

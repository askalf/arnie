---
name: systemd
description: Linux systemd troubleshooting — failed units, restart loops, journalctl triage, dependency cycles, socket activation, timers. Use when the user mentions systemctl, journalctl, a failed service, "won't start", or unit-file edits.
---

# systemd playbook

## Triage

1. `systemctl --failed` → the short list of broken units.
2. For each failing unit:
   - `systemctl status <unit>` → exit code, last lines of output, PID, cgroup.
   - `journalctl -u <unit> -n 200 --no-pager` → recent log lines specific to that unit.
   - `journalctl -u <unit> -p err --since "1 hour ago"` → just errors in a window.
3. If the unit won't even start: `systemd-analyze verify <unit>` to lint the unit file.

## Read the exit code first

`systemctl status` shows something like `Main process exited, code=exited, status=203/EXEC`. The status code is meaningful:

| Code | Meaning |
| --- | --- |
| `203/EXEC` | Binary at `ExecStart=` doesn't exist or isn't executable |
| `200/CHDIR` | `WorkingDirectory=` doesn't exist |
| `217/USER` | `User=` doesn't exist |
| `226/NAMESPACE` | `ProtectSystem=`, `PrivateTmp=`, etc. namespace setup failed (often AppArmor/SELinux) |
| `1` | Generic failure — read the journal |
| `signal=SIGKILL` | OOM-killer or `systemctl kill -s 9` — `dmesg | grep -i kill` |

## Restart loop

Symptom: unit is `activating (auto-restart)` forever.

- Check `Restart=`/`RestartSec=` in the unit. If `Restart=always` and the binary fails fast, the loop is intentional.
- `StartLimitBurst=` + `StartLimitIntervalSec=` rate-limit restarts; once exceeded the unit goes `failed` permanently. `systemctl reset-failed <unit>` clears that.
- Use `systemd-cgtop` to confirm it's actually consuming CPU — the loop might be benign.

## Dependency cycle

Symptom on boot: "Found ordering cycle on X.service/start."

- `systemd-analyze verify <unit>` names the cycle.
- Most common cause: `After=` + `Requires=` between two units that both want to start the other. Fix with `Wants=` (weaker) on one side.

## "Service starts but immediately fails"

- Check the actual command runs by hand: `sudo -u <serviceuser> /path/to/binary --flags`. If it works as a user but not under systemd, it's almost always:
  - PATH — systemd uses minimal `/usr/bin:/bin`. Set explicit binary paths or `Environment=PATH=...`.
  - cwd — `WorkingDirectory=` defaults to `/`.
  - sandboxing — `ProtectHome=`, `ProtectSystem=`, `PrivateTmp=` hide files the service expects.

## Socket activation

- For socket-activated units: `systemctl status foo.socket` (the socket) is separate from `foo.service` (the worker).
- "Connection refused" with the socket showing `listening` usually means `Accept=yes` units are crashing per-connection — check `journalctl -u foo@*.service`.

## Timers

- `systemctl list-timers --all` shows next/last fire and the linked service.
- A timer firing but doing nothing usually means the linked `.service` is failing fast — read its journal, not the timer's.

## Tools to reach for

- `shell` for `systemctl`, `journalctl`, `systemd-analyze`, `loginctl`
- `tail_log` on `/var/log/syslog` or `/var/log/messages` for non-journal logs
- `process_check` to see what the unit actually spawned

## Don't

- Don't `systemctl daemon-reload` casually mid-incident — it doesn't restart units, but it can mask the original error by re-reading edited files.
- Don't edit unit files in `/lib/systemd/system/` — package upgrades will overwrite. Use `systemctl edit <unit>` for drop-ins under `/etc/systemd/system/<unit>.d/`.

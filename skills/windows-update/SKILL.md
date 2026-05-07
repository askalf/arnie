---
name: windows-update
description: Windows Update troubleshooting — stuck installs, error codes (0x800f0922, 0x80073712, 0x80240034, etc.), component store corruption, WSUS misconfig. Use when the user mentions Windows Update, "stuck at X%", a `0x80...` error, or `wuauserv`.
---

# Windows Update playbook

## Triage

1. Capture the exact error code. The numeric form (`0x800f0922`) is googleable; the symbolic form (`CBS_E_INSTALLERS_FAILED`) is more diagnostic. `findstr` for the code in `C:\Windows\Logs\CBS\CBS.log` to see context.
2. Check service state: `Get-Service wuauserv, bits, cryptsvc, msiserver, trustedinstaller`. All should be running or startable.
3. Check disk space on `C:` — WU needs ~10 GB free for cumulative updates. `disk_check` is enough.

## Common error codes

| Code | Meaning | First fix |
| --- | --- | --- |
| `0x80073712` | Component store corruption (missing manifest) | `DISM /Online /Cleanup-Image /RestoreHealth` then `sfc /scannow` |
| `0x800f0922` | .NET install or rollback failure, or insufficient system-reserved partition space | Check sys-reserved partition free space (need >300 MB) |
| `0x80240034` | Download failed, often proxy/TLS | Check WinHTTP proxy: `netsh winhttp show proxy` |
| `0x8024401c` | Timeout reaching update source | Check WSUS reachability or unset WSUS to fall back to Microsoft |
| `0x80070643` | Generic install failure, often .NET or AV interference | Read `C:\Windows\Logs\CBS\CBS.log` near the timestamp |
| `0x800705b4` | Timeout — service hung or disk I/O blocked | Check `process_check` for high-IO process; clear `SoftwareDistribution\Download` |

## Reset path (the standard nuclear option)

Confirm with the user before running — this discards in-flight downloads and forces a re-scan against the upstream source.

```powershell
Stop-Service wuauserv, bits, cryptsvc, msiserver
Rename-Item C:\Windows\SoftwareDistribution C:\Windows\SoftwareDistribution.old
Rename-Item C:\Windows\System32\catroot2 C:\Windows\System32\catroot2.old
Start-Service wuauserv, bits, cryptsvc, msiserver
# trigger a fresh scan
UsoClient.exe StartScan
```

## WSUS-specific

- Check the configured server: `registry_read` on `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate` (`WUServer`, `WUStatusServer`).
- "Falls back to Microsoft" symptom: `DoNotConnectToWindowsUpdateInternetLocations` not set, or upstream unreachable. Confirm with `Test-NetConnection <wsus> -Port 8530` (or 8531 for SSL).
- Approval missing on the WSUS side will show as "no updates found" on the client even when ones exist — verify on the WSUS console, not just the client.

## Logs to read

- `C:\Windows\Logs\CBS\CBS.log` — component-based servicing, the authoritative install log. Use `tail_log` with regex `error|fail` to skip noise.
- `C:\Windows\Logs\DISM\dism.log` — for `RestoreHealth` failures.
- `Get-WindowsUpdateLog` (PowerShell) — converts ETW traces to a readable `WindowsUpdate.log` on the desktop.

## Don't

- Don't run `sfc /scannow` before `DISM /RestoreHealth` if the component store itself is corrupt — sfc can't repair what DISM hasn't reseeded.
- Don't delete `SoftwareDistribution\DataStore` while `wuauserv` is running — stop the service first.

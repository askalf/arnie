---
name: active-directory
description: Active Directory troubleshooting — replication, FSMO roles, GPO, secure-channel breaks, Kerberos failures. Use when the issue mentions a domain controller, AD authentication, group policy, or `dcdiag` / `repadmin` output.
---

# Active Directory playbook

Scoped to Windows Server domain environments. Most flows assume the user is running on a DC or a domain-joined member server with RSAT installed.

## Triage

1. Confirm DC reachability and time skew first — Kerberos breaks at >5 minutes drift.
   - `Test-NetConnection <dc> -Port 88` (Kerberos), `-Port 389` (LDAP), `-Port 445` (SMB), `-Port 636` (LDAPS).
   - `w32tm /stripchart /computer:<dc> /samples:3 /dataonly`
2. Run `dcdiag /v /c /e /q` once and read only the failures (`/q` suppresses pass lines).
3. For replication: `repadmin /replsummary` then `repadmin /showrepl <dc>` for the failing partner.

## Common failure modes

### Replication stuck / lingering objects

- `repadmin /replsummary` shows largest delta + failure count by partner.
- Check Event Log on source DC: `event_log` filter `source=NTDS Replication`, level=Error.
- Tombstone lifetime exceeded → lingering objects. Fix with `repadmin /removelingeringobjects`.

### Secure channel broken on member

- Symptom: "trust relationship between this workstation and the primary domain failed."
- Verify: `Test-ComputerSecureChannel -Verbose`
- Repair: `Test-ComputerSecureChannel -Repair -Credential (Get-Credential)` — preferred over re-joining the domain (preserves SID).

### FSMO role unreachable

- `netdom query fsmo` lists role holders.
- If the holder is permanently dead, **seize** (not transfer) via `ntdsutil`. Confirm with the user before seizing — it's irreversible without metadata cleanup.

### GPO not applying

- `gpresult /h gpreport.html /scope computer` — read the "Denied GPOs" + "Applied GPOs" sections.
- Common causes: WMI filter mismatch, security filtering excludes the computer/user, slow-link detection, sysvol replication broken.
- Check sysvol replication: `dfsrdiag pollad` then `Get-DfsrBacklog` between DCs.

### Kerberos auth failures

- Event ID 4 (KRB_AP_ERR_MODIFIED) on client = SPN mismatch or duplicate SPN.
- `setspn -X` finds duplicates domain-wide.
- For "the user account is not authorized to log on from this computer": check user's `userWorkstations` attribute or logon-hours restrictions.

## Tools to reach for

- `shell` with `Get-ADUser` / `Get-ADComputer` / `Get-ADReplicationFailure` / `Get-ADDomainController`
- `event_log` for `Directory Service`, `DFS Replication`, `DNS Server` channels
- `network_check` for port probes to DCs

## Don't

- Don't run `ntdsutil metadata cleanup` without confirming the DC is permanently gone.
- Don't `gpupdate /force` as the diagnostic — read `gpresult` first; force-refresh only after you understand what's failing.

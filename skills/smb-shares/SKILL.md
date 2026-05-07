---
name: smb-shares
description: SMB / CIFS file-share troubleshooting — connect failures, name resolution, NTLM/Kerberos auth, SMB1/2/3 negotiation, "STATUS_BAD_NETWORK_NAME", "ACCESS_DENIED". Use when the user mentions a UNC path, mapped drive, `net use`, `mount.cifs`, or a file-share they can't reach.
---

# SMB shares playbook

## Triage layers

Work bottom-up. Each layer assumes the one below works.

1. **Network reachability** — `Test-NetConnection <server> -Port 445` (Windows) or `network_check` with TCP probe to 445.
2. **Name resolution** — `Resolve-DnsName <server>` / `getent hosts <server>`. UNC paths fail differently for unresolvable names vs. unreachable IPs.
3. **SMB negotiation** — does a connection get to the protocol? `Get-SmbConnection` on Windows; `smbclient -L //<server> -U <user>` on Linux.
4. **Authentication** — does the user/credential get accepted?
5. **Authorization** — once authenticated, can the user see the share / read the file?

## Status codes (Windows)

| Code | Meaning | Where it lives |
| --- | --- | --- |
| `STATUS_BAD_NETWORK_NAME` (`0xc00000cc`) | Share doesn't exist on the server (or you're hitting the wrong host) | Check share enumeration: `net view \\server` |
| `STATUS_ACCESS_DENIED` (`0xc0000022`) | Auth succeeded, ACL denies | Check share + NTFS ACLs separately |
| `STATUS_LOGON_FAILURE` (`0xc000006d`) | Bad credentials or wrong domain | Often UPN vs. DOMAIN\user mismatch |
| `STATUS_ACCOUNT_LOCKED_OUT` (`0xc0000234`) | Too many bad attempts | Check Event Log on DC, source = Security, ID 4740 |
| `STATUS_DUPLICATE_NAME` (`0xc00000bd`) | Connecting back to local machine via its own NetBIOS name | Use IP or `\\127.0.0.1` for loopback |

## Common failure modes

### "ECONNREFUSED" / "no route to host" on 445

- Host firewall blocking — check `firewall_check` for the SMB-In rule.
- Domain isolation policy / ipsec.
- Server has SMB disabled (Windows Server with role removed, Samba not running).

### Connects but auth fails

- **Kerberos vs. NTLM**: hitting via FQDN tries Kerberos first; via IP forces NTLM. If only IP works, you've got an SPN issue. Verify `setspn -L <server>` lists `cifs/<fqdn>` and `HOST/<fqdn>`.
- **SMB signing**: client requires it, server doesn't offer (or vice versa). Check `Get-SmbServerConfiguration | Select RequireSecuritySignature`.
- **Guest auth disabled** (since Windows 10 1709): if the share is unauth, modern clients refuse it. Either fix the share to require auth, or override `AllowInsecureGuestAuth` (not recommended).

### "The specified network name is no longer available"

- Stale session — `Get-SmbConnection` then `Remove-SmbConnection` to drop, retry.
- Often follows network-blip events; check `event_log` source `Microsoft-Windows-SMBClient`.

### Slow share / hangs

- `Get-SmbMultichannelConnection` — multichannel can pick a bad NIC.
- Check SMB version negotiated: `Get-SmbConnection | Select ServerName, Dialect`. SMB1 fallback (`2.02` or `1.0`) on a modern server is suspicious.
- Oplocks / leasing issues with antivirus on either end — temporarily disable AV on the share root to confirm.

## Linux client (cifs-utils)

- Verbose mount: `mount -t cifs //server/share /mnt -o username=user,vers=3.0,sec=krb5 -v`
- `dmesg | tail` after a failed mount almost always has the real reason.
- `vers=3.0` is a sane default; `vers=auto` can mis-negotiate against old servers.
- `sec=ntlmssp` for AD-joined NTLM, `sec=krb5` for Kerberos (needs working keytab + DNS).

## Tools to reach for

- `network_check` for 445/139 reachability + DNS
- `service_check` for `LanmanServer`, `LanmanWorkstation` (Windows) or `smbd`/`nmbd` (Samba)
- `event_log` for `Microsoft-Windows-SMBClient/Connectivity`, `Microsoft-Windows-SMBServer/Operational`
- `firewall_check` for the SMB-In rule on the server side

## Don't

- Don't enable SMB1 to "make it work" — it's deprecated and unsafe. If a device requires SMB1, isolate it on its own VLAN.
- Don't change `AllowInsecureGuestAuth` cluster-wide as a fix; it widens the attack surface for one broken share.

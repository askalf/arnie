# Worked examples

Concrete troubleshooting sessions to show what arnie looks like in practice. Each example is paraphrased from a real flow — abbreviated for readability, but the tools fired and the structure are accurate.

## 1. Printer queue jammed, can't restart spooler

```
you> the print queue's stuck and net stop spooler hangs
```

What arnie does:

1. `service_check` for `Spooler` → state `StopPending`.
2. `process_check` filtered by `spoolsv` → finds the PID.
3. `shell` → `Get-Process spoolsv | Select Id, StartTime, Path` to confirm it's the system service, not a user process.
4. Notes that `StopPending` usually means a driver thread is wedged. Proposes:
   - `Stop-Process -Id <pid> -Force` (asks for confirmation — destructive)
   - Then `Get-ChildItem C:\Windows\System32\spool\PRINTERS\*.SHD,*.SPL | Remove-Item` to clear stuck jobs (asks for confirmation)
   - Then `Start-Service Spooler`

```
arnie> spoolsv (PID 4216) is StopPending — most likely a wedged driver thread.
       safest fix is force-kill, clear the spool dir, restart the service.
       want me to:
         1) Stop-Process -Id 4216 -Force      [destructive, will confirm]
         2) clear C:\Windows\System32\spool\PRINTERS\*  [destructive, will confirm]
         3) Start-Service Spooler
       y/n?
```

Key arnie behaviors on display: it investigates state before mutating, batches destructive actions into a single approval prompt, and explicitly names what each step does.

## 2. "Disk full" but `du` says otherwise

```
you> the box says C: is full but du says i'm only using 60GB out of 500
```

What arnie does:

1. `disk_check` → confirms `C:` shows ~5 GB free of 500 GB.
2. `shell` → `Get-Volume C | Select SizeRemaining, Size` to confirm at the volume layer (not just user files).
3. Reaches for the usual suspects in order:
   - VSS shadow copies eating space: `vssadmin list shadowstorage`
   - `WinSxS` bloat: `Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore`
   - Hibernate file: `dir C:\hiberfil.sys /a` (often 75% of RAM size)
   - Pagefile growth: `dir C:\pagefile.sys /a`
4. Finds `vssadmin list shadowstorage` reports 380 GB used.

```
arnie> shadow copies on C: are using 380 GB. that's the gap.
       to reclaim:
         vssadmin delete shadows /for=C: /oldest    (delete one at a time, safest)
         vssadmin delete shadows /for=C: /all       (nuke them all)
       want me to delete just the oldest first and re-check?
```

Key arnie behaviors on display: arnie distinguishes the user-data view from the volume view, runs a checklist in order of likelihood, and proposes the *least destructive* fix first.

## 3. App can't reach a port that "should be open"

```
you> our app can't connect to 10.0.0.5:5432. ops swears the firewall's open
```

What arnie does:

1. `network_check` to `10.0.0.5` ICMP + TCP 5432 → ICMP succeeds, TCP times out.
2. `shell` → `Test-NetConnection 10.0.0.5 -Port 5432 -InformationLevel Detailed` to get the source IP arnie's connection used.
3. Observes the source IP is `192.168.5.10` (a non-routable second NIC), not the expected `10.0.0.20`.
4. `shell` → `Get-NetRoute -DestinationPrefix 10.0.0.0/8` shows the route is via the wrong interface.

```
arnie> reachability is fine at L3 (ICMP works). TCP 5432 is being routed out
       192.168.5.10 (Ethernet 2), not 10.0.0.20 (Ethernet 1). the postgres
       host's ACL probably allows 10.0.0.0/8 but not 192.168.0.0/16.
       two fixes:
         a) drop interface metric on Ethernet 2 so it's not preferred
         b) add an explicit route: route add 10.0.0.0 mask 255.0.0.0 10.0.0.1
       (a) is durable, (b) is non-persistent. which?
```

Key arnie behaviors on display: it doesn't trust the framing ("firewall must be the issue"). It probes the actual path the connection takes and finds the mis-routing.

## 4. AD authentication failing on one workstation

```
you> one laptop can't log into the domain. trust relationship error
```

What arnie does (active-directory skill loads automatically when it sees "trust relationship"):

1. `shell` → `Test-ComputerSecureChannel -Verbose` → returns False.
2. Checks time skew: `w32tm /stripchart /computer:dc01 /samples:3 /dataonly` → 6 minutes off. *Two* problems.
3. Checks DNS: `Resolve-DnsName _ldap._tcp.dc._msdcs.<domain>` → returns the right DCs.

```
arnie> two issues stacked:
         1) clock is 6 min off the DC — kerberos breaks at 5+. fix first.
         2) machine secure channel is broken (NetLogon password mismatch).

       proposed order:
         a) w32tm /resync /force                            (sync time)
         b) Test-ComputerSecureChannel -Repair -Credential …  (re-key)
         c) re-run Test-ComputerSecureChannel to confirm

       want creds prompted for step (b)?
```

Key arnie behaviors on display: when a skill applies, the playbook (clock first, then secure channel) drives the order. It doesn't jump to "rejoin the domain" — that destroys the SID and the Kerberos repair is preferred.

## 5. CrashLooping pod in a k8s cluster

```
you> deploy/web-frontend has been crashlooping for an hour. logs are empty
```

What arnie does (kubernetes-pod-triage skill loads):

1. `shell` → `kubectl describe pod -l app=web-frontend -n prod` → reads Events. Sees `Back-off restarting failed container`.
2. `shell` → `kubectl logs -l app=web-frontend -n prod --previous --tail=100` (note: `--previous`!) → returns log output that the live container doesn't have.
3. Logs show `panic: getaddrinfoa failed: lookup config-service on 10.96.0.10: no such host`.
4. `shell` → `kubectl get svc config-service -n prod` → "not found".
5. `shell` → `kubectl get svc config-service -A` → finds it in `staging` namespace.

```
arnie> the pod's panicking on startup because it can't resolve `config-service`.
       that service exists in `staging`, not `prod`. either:
         a) the deploy was promoted from staging without updating the configmap
            with the FQDN form (config-service.staging.svc.cluster.local)
         b) someone forgot to apply the prod manifest for the service

       want me to grep the configmap for the hostname and confirm which?
```

Key arnie behaviors on display: `--previous` is a small detail that turns "logs are empty" into a clear diagnosis. The skill encodes this so arnie reaches for it automatically.

---

These flows are illustrative — your exact sessions will vary based on the box, the skills loaded, and the model's running context. The pattern is consistent: **investigate before mutating, propose before acting, name the destructive bits explicitly.**

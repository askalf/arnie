---
name: kubernetes-pod-triage
description: Kubernetes pod-level troubleshooting — CrashLoopBackOff, ImagePullBackOff, Pending, OOMKilled, readiness/liveness probe failures. Use when the user mentions kubectl, a pod stuck in a non-Running state, or container restart loops.
---

# Kubernetes pod triage playbook

Scoped to debugging a single misbehaving workload. Out of scope: cluster install, networking plugins, control-plane health.

## Triage in order

1. `kubectl get pod <pod> -n <ns> -o wide` — node it's scheduled on, IP, restart count.
2. `kubectl describe pod <pod> -n <ns>` — read the **Events** section at the bottom first; it's where the actual reason lives.
3. `kubectl logs <pod> -n <ns> -c <container> --previous` — `--previous` is the dead container; the live one is usually mid-crash and has nothing.

## Common phases / reasons

### `Pending` — never scheduled

Read events. Usually one of:

- `0/N nodes are available: insufficient cpu/memory.` — request too high or cluster too small.
- `node(s) had untolerated taint`. — pod missing a toleration for the target nodes.
- `pod has unbound immediate PersistentVolumeClaims`. — PVC in `Pending`; check `kubectl describe pvc`.

### `ImagePullBackOff` / `ErrImagePull`

- Wrong image tag → `kubectl describe` shows `manifest unknown` or `not found`.
- Private registry, missing auth → `imagePullSecrets` not set on the pod or the secret is wrong namespace.
- Network → exec into a debug pod on the same node and try `crictl pull <image>` or curl the registry. DNS often the culprit.

### `CrashLoopBackOff`

The container starts, exits, restarts, and is now being backoff-throttled. The interesting question is *why it exits*.

- `kubectl logs --previous` is mandatory.
- If logs are empty, the binary is probably crashing before it can log. Try:
  - `kubectl get pod -o yaml | yq .spec.containers[].command` — confirm command/args are what you expect.
  - Run the image locally with `docker run --rm -it <image> sh` to inspect.
- Exit code mapping (find it under `lastState.terminated.exitCode`):
  - `0` — exited cleanly. Probably no foreground process; `command:` is wrong.
  - `1` — generic app error. Read logs.
  - `137` — SIGKILL, almost always OOM. Check `lastState.terminated.reason: OOMKilled` and bump `resources.limits.memory`.
  - `139` — SIGSEGV. Bug or arch mismatch (arm64 image on amd64 node).
  - `143` — SIGTERM. Pod was evicted or `terminationGracePeriodSeconds` expired mid-shutdown.

### `Running` but `Ready: 0/1`

Liveness/readiness probe failing. `describe` shows the probe failure under Events.

- Misconfigured probe path or port.
- App not listening on `0.0.0.0` (only `127.0.0.1`) — kubelet can't reach it.
- `initialDelaySeconds` too short for slow-starting apps; check the actual startup time in logs.

### Evicted

- Node pressure (disk/memory). `kubectl describe node <node>` → conditions section.
- Find the offender: `kubectl top pods --all-namespaces --sort-by=memory` (needs metrics-server).

## Tools to reach for

- `shell` with `kubectl` (verify context first: `kubectl config current-context`)
- `subagent` for "list every CrashLooping pod across all namespaces and group by reason" — bounded read-only enumeration is exactly what it's for.
- `monitor` to watch `kubectl get pod <pod> -w` style output between attempts.

## Don't

- Don't `kubectl delete pod` as a fix — it papers over the real cause and the controller will recreate it with the same problem.
- Don't `kubectl edit` a Deployment to mutate a single field permanently — patch via `kubectl patch` or update the source manifest, otherwise GitOps reconciles it back.
- Don't run cluster-wide `kubectl get pods --all-namespaces` repeatedly in a tight loop — on big clusters this is expensive. Filter with `--field-selector=status.phase!=Running`.

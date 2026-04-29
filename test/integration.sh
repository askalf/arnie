#!/usr/bin/env bash
# Arnie integration suite — exercises the full arnie binary end-to-end
# against a real backend.
#
# Mode selection:
#   - default: prefer dario at http://localhost:3456 (no API tokens
#     burned). If dario isn't reachable but ANTHROPIC_API_KEY is set,
#     auto-fall-back to direct API calls. If neither, skip cleanly.
#   - --direct: skip dario entirely, require ANTHROPIC_API_KEY.
#   - --dario:  require dario; don't auto-fall-back.
#
# Skipping (exit 0, marked SKIP) is the right answer when no backend is
# reachable — keeps CI/test:integration safe to wire in unconditionally.
#
# Usage:
#   bash test/integration.sh             # auto: dario → API → skip
#   bash test/integration.sh --direct    # require ANTHROPIC_API_KEY
#   bash test/integration.sh --dario     # require dario at :3456
set -u

MODE="auto"
case "${1:-}" in
  --direct) MODE="direct" ;;
  --dario)  MODE="dario" ;;
  "")       MODE="auto" ;;
  *)        echo "unknown arg: ${1}. Use --direct, --dario, or no arg for auto." >&2; exit 2 ;;
esac

# ---- backend availability gate ---------------------------------------
dario_reachable() {
  curl -s -o /dev/null -m 2 http://localhost:3456/ 2>/dev/null
}

if [ "$MODE" = "auto" ]; then
  if dario_reachable; then
    MODE="dario"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    MODE="direct"
    echo "[INFO] dario not reachable; falling back to --direct (ANTHROPIC_API_KEY is set)"
  else
    echo "[SKIP] integration: no dario at http://localhost:3456 and ANTHROPIC_API_KEY is unset"
    exit 0
  fi
fi

if [ "$MODE" = "dario" ]; then
  if ! dario_reachable; then
    echo "[SKIP] integration: no dario proxy at http://localhost:3456 (start one with: dario proxy &)"
    exit 0
  fi
  ARNIE=(node dist/cli.js --dario)
else
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "[SKIP] integration: --direct mode requested but ANTHROPIC_API_KEY is unset"
    exit 0
  fi
  ARNIE=(node dist/cli.js)
fi

# Common flags: keep noise down, no transcript pollution, no project memory/skills
ARNIE+=(--no-usage --no-status-line --no-transcript --no-memory --no-skills)

if [ ! -f dist/cli.js ]; then
  echo "[ERR] dist/cli.js not found — run 'npm run build' first"
  exit 2
fi

PASS=0; FAIL=0
declare -a FAILS=()

run() {
  local label="$1"; shift
  local expect_re="$1"; shift
  local prompt="$1"; shift
  local out
  out=$("${ARNIE[@]}" "$@" --print "$prompt" 2>&1)
  local rc=$?
  if [ $rc -ne 0 ]; then
    FAIL=$((FAIL+1)); FAILS+=("$label: exit $rc")
    printf "  [FAIL] %-32s (exit %d)\n" "$label" "$rc"
    return
  fi
  if echo "$out" | grep -qiE "$expect_re"; then
    PASS=$((PASS+1))
    printf "  [ ok ] %-32s\n" "$label"
  else
    FAIL=$((FAIL+1)); FAILS+=("$label: no match for /$expect_re/")
    printf "  [FAIL] %-32s (no /%s/)\n" "$label" "$expect_re"
    echo "         last: $(echo "$out" | tail -1 | head -c 120)"
  fi
}

# Fixture under a path Node can resolve on Windows (bash's /tmp aliases
# to %LOCALAPPDATA%\Temp but Node treats /tmp as the literal "/tmp" and
# resolves it to C:\tmp, which doesn't exist).
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) FIX="${LOCALAPPDATA:-$USERPROFILE/AppData/Local}/Temp/arnie-it-$$" ;;
  *)                    FIX="/tmp/arnie-it-$$" ;;
esac
# Normalize backslashes for bash use
FIX="${FIX//\\//}"
mkdir -p "$FIX"
cat > "$FIX/sample.txt" <<'EOF'
line 1: alpha
line 2: bravo
line 3: charlie MAGIC_TOKEN
line 4: delta
EOF
cat > "$FIX/log.txt" <<'EOF'
2026-04-28T10:00:02 ERROR connection refused 10.0.0.5
2026-04-28T10:00:03 WARN  retry scheduled
EOF

echo "arnie integration suite ($MODE)"
echo "fixture: $FIX"
echo

echo "=== A. Read tools ==="
run "read_file"      "MAGIC_TOKEN"            "Read $FIX/sample.txt and quote the magic token line."
run "grep"           "MAGIC_TOKEN"            "Grep for MAGIC_TOKEN in $FIX. Quote the match."
run "list_dir"       "sample\\.txt"           "List $FIX. Name the entries."
run "tail_log"       "ERROR.*10\\.0\\.0\\.5" "Use tail_log on $FIX/log.txt filtered by /ERROR/. Quote the line."
run "disk_check"     "free|GB|drive"          "Run disk_check. One sentence about free space."
run "process_check"  "node|System|svchost|wininit|explorer|chrome" "Use process_check; list 3 processes by memory."
run "network_check"  "loopback|reachable|reply|ttl|alive|127\\.0\\.0\\.1" "network_check ping 127.0.0.1. Reachable?"

echo
echo "=== B. Write tools (require y\\n on stdin) ==="
echo "before" > "$FIX/edit.txt"
printf 'y\ny\n' | "${ARNIE[@]}" --print "Use edit_file on $FIX/edit.txt to replace 'before' with 'after'." >/dev/null 2>&1
if grep -q "after" "$FIX/edit.txt" 2>/dev/null; then
  echo "  [ ok ] edit_file persisted"; PASS=$((PASS+1))
else
  echo "  [FAIL] edit_file did not persist"; FAIL=$((FAIL+1)); FAILS+=("edit_file persist")
fi
printf 'y\ny\n' | "${ARNIE[@]}" --print "Use write_file to create $FIX/new.txt containing the single line: HELLO_WRITE." >/dev/null 2>&1
if grep -q "HELLO_WRITE" "$FIX/new.txt" 2>/dev/null; then
  echo "  [ ok ] write_file persisted"; PASS=$((PASS+1))
else
  echo "  [FAIL] write_file did not persist"; FAIL=$((FAIL+1)); FAILS+=("write_file persist")
fi

echo
echo "=== C. Modes ==="
run "--dry-run describes" "Get-ComputerInfo|systeminfo|winver|OSVersion|uname|would" \
    "Describe (without running) the shell command for the OS version." --dry-run
run "--system-extra"   "ZEBRA"               "What's your secret word?" --system-extra "Your secret word is ZEBRA. Always say it when asked."

echo
echo "=== D. Cost budget (regression test for v1.1.1) ==="
out=$("${ARNIE[@]}" --budget 0.0001 --print "say: hi" 2>&1)
rc=$?
if echo "$out" | grep -qi "budget exceeded" && [ $rc -ne 0 ]; then
  echo "  [ ok ] --budget warns + exits non-zero in --print"; PASS=$((PASS+1))
else
  echo "  [FAIL] --budget did not warn/exit (rc=$rc, out=$(echo "$out" | tail -1 | head -c 80))"
  FAIL=$((FAIL+1)); FAILS+=("--budget regression")
fi

rm -rf "$FIX"
echo
echo "==============================="
echo "  $MODE: pass=$PASS  fail=$FAIL"
if [ $FAIL -gt 0 ]; then
  echo "  failures:"
  for f in "${FAILS[@]}"; do echo "   - $f"; done
  exit 1
fi
exit 0

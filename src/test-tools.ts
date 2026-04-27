import { runReadFile } from "./tools/readFile.js";
import { runShell } from "./tools/shell.js";

interface Case {
  name: string;
  pass: boolean;
  detail?: string;
}

const cases: Case[] = [];

const DESTRUCTIVE_PATTERNS = [
  { pattern: /\brm\b\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|-[a-zA-Z]+\s+)*/, name: "rm with flags" },
  { pattern: /\bRemove-Item\b/i, name: "Remove-Item" },
  { pattern: /\bformat\b\s+[a-zA-Z]:/i, name: "drive format" },
  { pattern: /\breg\s+(?:delete|add)/i, name: "registry edit" },
  { pattern: /\b(?:apt|apt-get|yum|dnf|pacman)\s+(?:remove|purge|autoremove)\b/i, name: "package removal" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, name: "shutdown" },
];

function matches(cmd: string): string | null {
  for (const { pattern, name } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) return name;
  }
  return null;
}

const positive = [
  "rm -rf /tmp/foo",
  "Remove-Item C:\\Users\\foo\\bar -Recurse",
  "format c:",
  "reg delete HKLM\\Software\\Foo",
  "sudo apt remove nginx",
  "shutdown -h now",
];
for (const cmd of positive) {
  const hit = matches(cmd);
  cases.push({
    name: `destructive detected: ${cmd}`,
    pass: hit !== null,
    detail: hit ?? "NO MATCH",
  });
}

const negative = [
  "ls -la",
  "cat /etc/hosts",
  "Get-Process",
  "ipconfig /all",
  "git status",
  "ps aux",
  "df -h",
];
for (const cmd of negative) {
  const hit = matches(cmd);
  cases.push({
    name: `safe NOT flagged: ${cmd}`,
    pass: hit === null,
    detail: hit ? `false positive: ${hit}` : "ok",
  });
}

async function readFileTests(): Promise<void> {
  const r1 = await runReadFile({ path: "package.json" });
  cases.push({
    name: "read_file: read package.json",
    pass: r1.ok && r1.content !== undefined && r1.content.includes('"name": "arnie"'),
    detail: r1.ok ? `${r1.bytes} bytes, name found=${r1.content?.includes('"name": "arnie"')}` : `error: ${r1.error}`,
  });

  const r2 = await runReadFile({ path: "package.json", start_line: 1, end_line: 3 });
  cases.push({
    name: "read_file: line range 1-3",
    pass: r2.ok && r2.content !== undefined && r2.content.split("\n").length === 3,
    detail: r2.ok ? `lines=${r2.content?.split("\n").length}` : `error: ${r2.error}`,
  });

  const r3 = await runReadFile({ path: "this-file-does-not-exist.xyz" });
  cases.push({
    name: "read_file: missing file returns error",
    pass: !r3.ok && r3.error !== undefined,
    detail: r3.error ?? "expected error, got success",
  });

  const r4 = await runReadFile({ path: "src" });
  cases.push({
    name: "read_file: directory returns error",
    pass: !r4.ok && r4.error !== undefined && r4.error.toLowerCase().includes("directory"),
    detail: r4.error ?? "expected directory error",
  });
}

async function shellTests(): Promise<void> {
  const echoCmd = process.platform === "win32" ? 'Write-Output "hello-from-arnie"' : 'echo "hello-from-arnie"';
  const r1 = await runShell({ command: echoCmd, reason: "test echo" });
  cases.push({
    name: "shell: echo captures stdout",
    pass: r1.ok && r1.stdout.includes("hello-from-arnie"),
    detail: r1.ok ? `exit=${r1.exit_code}, stdout="${r1.stdout.trim()}"` : `failed: ${r1.stderr}`,
  });

  const r2 = await runShell({
    command: process.platform === "win32" ? "exit 7" : "exit 7",
    reason: "test non-zero exit",
  });
  cases.push({
    name: "shell: non-zero exit reported",
    pass: !r2.ok && r2.exit_code === 7,
    detail: `ok=${r2.ok}, exit_code=${r2.exit_code}`,
  });

  const r3 = await runShell({
    command: process.platform === "win32" ? "Get-Date -Format yyyy" : "date +%Y",
    reason: "test current year",
  });
  const year = new Date().getFullYear().toString();
  cases.push({
    name: "shell: real command output",
    pass: r3.ok && r3.stdout.includes(year),
    detail: r3.ok ? `output contains ${year}: ${r3.stdout.includes(year)}` : `failed: ${r3.stderr}`,
  });
}

async function main(): Promise<void> {
  await readFileTests();
  await shellTests();

  console.log();
  console.log("=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));

  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const tag = c.pass ? "PASS" : "FAIL";
    const line = `[${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
    console.log(line);
    if (c.pass) passed++;
    else failed++;
  }

  console.log();
  console.log(`${passed} passed, ${failed} failed (${cases.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

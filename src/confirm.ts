import readline from "node:readline";
import chalk from "chalk";

let sharedRl: readline.Interface | null = null;
const lineQueue: string[] = [];
const waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];
let stdinClosed = false;

function init(): void {
  if (sharedRl) return;
  sharedRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  sharedRl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w.resolve(line);
    else lineQueue.push(line);
  });
  sharedRl.on("close", () => {
    stdinClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.reject(new Error("stdin closed"));
    }
  });
}

export function closeReadline(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

export async function prompt(message: string): Promise<string> {
  init();
  process.stdout.write(message);
  if (lineQueue.length > 0) {
    const line = lineQueue.shift()!;
    process.stdout.write(line + "\n");
    return line;
  }
  if (stdinClosed) throw new Error("stdin closed");
  return new Promise<string>((resolve, reject) => {
    waiters.push({ resolve, reject });
  });
}

export async function confirm(message: string): Promise<boolean> {
  try {
    const answer = await prompt(`${chalk.yellow(message)} ${chalk.dim("[y/N] ")}`);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  }
}

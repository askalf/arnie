import chalk from "chalk";
import { prompt } from "./confirm.js";

const MULTILINE_DELIM = '"""';

export async function readUserInput(): Promise<string | null> {
  let line: string;
  try {
    line = await prompt(chalk.bold.green("you> "));
  } catch {
    return null;
  }

  const trimmed = line.trim();
  if (trimmed === MULTILINE_DELIM) {
    return readMultiline();
  }

  if (trimmed.startsWith(MULTILINE_DELIM) && trimmed.length > MULTILINE_DELIM.length) {
    const start = trimmed.slice(MULTILINE_DELIM.length);
    return readMultilineWithStart(start);
  }

  return line;
}

async function readMultiline(): Promise<string | null> {
  const lines: string[] = [];
  while (true) {
    let line: string;
    try {
      line = await prompt(chalk.dim("... "));
    } catch {
      if (lines.length > 0) return lines.join("\n");
      return null;
    }
    if (line.trim() === MULTILINE_DELIM) break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function readMultilineWithStart(start: string): Promise<string | null> {
  const lines = [start];
  while (true) {
    let line: string;
    try {
      line = await prompt(chalk.dim("... "));
    } catch {
      return lines.join("\n");
    }
    if (line.trim() === MULTILINE_DELIM) break;
    lines.push(line);
  }
  return lines.join("\n");
}

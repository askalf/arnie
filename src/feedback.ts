import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const FEEDBACK_FILE = path.join(os.homedir(), ".arnie", "feedback.md");

export async function appendFeedback(text: string): Promise<string> {
  const dir = path.dirname(FEEDBACK_FILE);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  const block = `\n---\n_[${ts}]_\n${text.trim()}\n`;
  await fs.appendFile(FEEDBACK_FILE, block, "utf8");
  return FEEDBACK_FILE;
}

export async function loadFeedback(): Promise<string | null> {
  try {
    const text = await fs.readFile(FEEDBACK_FILE, "utf8");
    if (text.trim().length === 0) return null;
    return text.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function clearFeedback(): Promise<void> {
  try {
    await fs.unlink(FEEDBACK_FILE);
  } catch {
    // ignore
  }
}

export function feedbackPath(): string {
  return FEEDBACK_FILE;
}

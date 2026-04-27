import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface PersonaOverride {
  text: string;
  source: string;
}

export async function loadPersonaOverride(): Promise<PersonaOverride | null> {
  const candidates = [
    path.join(process.cwd(), ".arnie", "persona.md"),
    path.join(os.homedir(), ".arnie", "persona.md"),
  ];
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, "utf8");
      if (text.trim().length > 0) return { text: text.trim(), source: file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}

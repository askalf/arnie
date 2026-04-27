import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type Anthropic from "@anthropic-ai/sdk";

function blockToMarkdown(block: unknown): string {
  const b = block as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") {
    return b.text;
  }
  if (b.type === "tool_use") {
    const name = String(b.name ?? "");
    const input = JSON.stringify(b.input ?? {}, null, 2);
    return `<details><summary>tool_use: <code>${name}</code></summary>\n\n\`\`\`json\n${input}\n\`\`\`\n\n</details>`;
  }
  if (b.type === "tool_result") {
    const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    return `<details><summary>tool_result</summary>\n\n\`\`\`json\n${content}\n\`\`\`\n\n</details>`;
  }
  if (b.type === "thinking") {
    return ""; // thinking blocks are noise in transcripts
  }
  return `<details><summary>${b.type}</summary>\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n\n</details>`;
}

function messageToMarkdown(message: Anthropic.MessageParam): string {
  const role = message.role === "user" ? "User" : "Arnie";
  const lines: string[] = [`### ${role}`, ""];
  if (typeof message.content === "string") {
    lines.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const md = blockToMarkdown(block);
      if (md) lines.push(md);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function exportConversation(name: string, model: string, messages: Anthropic.MessageParam[]): Promise<string> {
  const dir = path.join(os.homedir(), ".arnie", "exports");
  await fs.mkdir(dir, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(dir, `${safe}.md`);

  const header = [
    `# arnie session: ${name}`,
    "",
    `- Exported: ${new Date().toISOString()}`,
    `- Model: ${model}`,
    `- Messages: ${messages.length}`,
    "",
    "---",
    "",
  ].join("\n");

  const body = messages.map(messageToMarkdown).join("\n");
  await fs.writeFile(file, header + body, "utf8");
  return file;
}

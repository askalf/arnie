import chalk from "chalk";

export interface MarkdownRenderer {
  push: (delta: string) => void;
  flush: () => void;
}

interface RendererState {
  buffer: string;
  inFence: boolean;
  fenceLang: string;
  enabled: boolean;
}

function processLine(line: string): string {
  let out = line;
  // ATX headers
  if (/^#{1,6}\s+/.test(out)) {
    const level = out.match(/^(#{1,6})/)![1].length;
    const rest = out.replace(/^#{1,6}\s+/, "");
    out = chalk.bold.cyan(rest);
    if (level <= 2) out = chalk.bold.cyan(out);
  }
  // Inline code
  out = out.replace(/`([^`\n]+)`/g, (_, code) => chalk.cyan(code));
  // Bold
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => chalk.bold(t));
  // Bullet points
  out = out.replace(/^(\s*)[*-]\s+/, (_, indent) => `${indent}${chalk.dim("•")} `);
  // Numbered lists
  out = out.replace(/^(\s*)(\d+\.)\s+/, (_, indent, num) => `${indent}${chalk.dim(num)} `);
  return out;
}

export function createMarkdownRenderer(enabled: boolean): MarkdownRenderer {
  const state: RendererState = { buffer: "", inFence: false, fenceLang: "", enabled };

  function emitLine(line: string, hasNewline: boolean): void {
    if (!state.enabled) {
      process.stdout.write(line + (hasNewline ? "\n" : ""));
      return;
    }
    const fenceOpen = /^```(\w*)\s*$/.exec(line);
    if (fenceOpen && !state.inFence) {
      state.inFence = true;
      state.fenceLang = fenceOpen[1];
      process.stdout.write(chalk.dim(`┌─ ${fenceOpen[1] || "code"} ─\n`));
      return;
    }
    if (state.inFence && /^```\s*$/.test(line)) {
      state.inFence = false;
      state.fenceLang = "";
      process.stdout.write(chalk.dim(`└─\n`));
      return;
    }
    if (state.inFence) {
      process.stdout.write(chalk.dim("│ ") + line + (hasNewline ? "\n" : ""));
      return;
    }
    process.stdout.write(processLine(line) + (hasNewline ? "\n" : ""));
  }

  return {
    push(delta) {
      state.buffer += delta;
      while (true) {
        const idx = state.buffer.indexOf("\n");
        if (idx === -1) break;
        const line = state.buffer.slice(0, idx);
        emitLine(line, true);
        state.buffer = state.buffer.slice(idx + 1);
      }
    },
    flush() {
      if (state.buffer.length === 0) return;
      emitLine(state.buffer, false);
      state.buffer = "";
    },
  };
}

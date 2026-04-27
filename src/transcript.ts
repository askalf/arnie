import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type Anthropic from "@anthropic-ai/sdk";

export interface TranscriptWriter {
  path: string | null;
  startSession: (meta: SessionMeta) => Promise<void>;
  appendUser: (content: string) => Promise<void>;
  appendAssistant: (message: Anthropic.Message) => Promise<void>;
  appendToolResults: (results: Anthropic.ToolResultBlockParam[]) => Promise<void>;
  appendError: (message: string) => Promise<void>;
  endSession: () => Promise<void>;
  enabled: boolean;
}

export interface SessionMeta {
  model: string;
  effort?: string;
  cwd: string;
  hostname: string;
  user: string;
}

interface TranscriptOptions {
  enabled: boolean;
  dir?: string;
}

export function createTranscriptWriter(opts: TranscriptOptions): TranscriptWriter {
  if (!opts.enabled) {
    const noop = async () => {};
    return {
      path: null,
      startSession: noop,
      appendUser: noop,
      appendAssistant: noop,
      appendToolResults: noop,
      appendError: noop,
      endSession: noop,
      enabled: false,
    };
  }

  const dir = opts.dir ?? path.join(os.homedir(), ".arnie", "transcripts");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${ts}.jsonl`);
  let initialized = false;

  async function ensureInit(): Promise<void> {
    if (initialized) return;
    await fs.mkdir(dir, { recursive: true });
    initialized = true;
  }

  async function write(record: Record<string, unknown>): Promise<void> {
    await ensureInit();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await fs.appendFile(file, line, "utf8");
  }

  return {
    get path() {
      return file;
    },
    enabled: true,
    async startSession(meta) {
      await write({ kind: "session_start", ...meta });
    },
    async appendUser(content) {
      await write({ kind: "user", content });
    },
    async appendAssistant(message) {
      await write({
        kind: "assistant",
        stop_reason: message.stop_reason,
        usage: message.usage,
        content: message.content,
      });
    },
    async appendToolResults(results) {
      await write({ kind: "tool_results", results });
    },
    async appendError(message) {
      await write({ kind: "error", message });
    },
    async endSession() {
      await write({ kind: "session_end" });
    },
  };
}

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

import { SHELL_TOOL_DEFINITION, runShell } from "./shell.js";
import { READ_FILE_TOOL_DEFINITION, runReadFile } from "./readFile.js";
import { LIST_DIR_TOOL_DEFINITION, runListDir } from "./listDir.js";
import { WRITE_FILE_TOOL_DEFINITION, runWriteFile } from "./writeFile.js";
import { GREP_TOOL_DEFINITION, runGrep } from "./grep.js";
import {
  SHELL_BG_TOOL_DEFINITION,
  SHELL_STATUS_TOOL_DEFINITION,
  SHELL_KILL_TOOL_DEFINITION,
  runShellBackground,
  runShellStatus,
  runShellKill,
} from "./backgroundShell.js";

const shellSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(1).max(300).optional(),
  reason: z.string().optional(),
});

const readFileSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

const listDirSchema = z.object({
  path: z.string().min(1),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(["overwrite", "create_only"]).optional(),
  reason: z.string().optional(),
});

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).optional(),
  context: z.number().int().min(0).max(5).optional(),
  glob: z.string().optional(),
  literal: z.boolean().optional(),
});

const shellBgSchema = z.object({
  command: z.string().min(1),
  reason: z.string().optional(),
});

const shellStatusSchema = z.object({
  job_id: z.string().min(1),
  output_max_chars: z.number().int().min(100).optional(),
});

const shellKillSchema = z.object({
  job_id: z.string().min(1),
});

interface ToolHandler {
  schema: z.ZodTypeAny;
  run: (input: unknown) => Promise<unknown>;
}

const HANDLERS: Record<string, ToolHandler> = {
  shell: { schema: shellSchema, run: (i) => runShell(i as z.infer<typeof shellSchema>) },
  read_file: { schema: readFileSchema, run: (i) => runReadFile(i as z.infer<typeof readFileSchema>) },
  list_dir: { schema: listDirSchema, run: (i) => runListDir(i as z.infer<typeof listDirSchema>) },
  write_file: { schema: writeFileSchema, run: (i) => runWriteFile(i as z.infer<typeof writeFileSchema>) },
  grep: { schema: grepSchema, run: (i) => runGrep(i as z.infer<typeof grepSchema>) },
  shell_background: { schema: shellBgSchema, run: (i) => runShellBackground(i as z.infer<typeof shellBgSchema>) },
  shell_status: { schema: shellStatusSchema, run: (i) => runShellStatus(i as z.infer<typeof shellStatusSchema>) },
  shell_kill: { schema: shellKillSchema, run: (i) => runShellKill(i as z.infer<typeof shellKillSchema>) },
};

export interface ToolDispatchOptions {
  webSearch: boolean;
}

export function buildToolList(opts: ToolDispatchOptions): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [
    SHELL_TOOL_DEFINITION,
    READ_FILE_TOOL_DEFINITION,
    LIST_DIR_TOOL_DEFINITION,
    WRITE_FILE_TOOL_DEFINITION,
    GREP_TOOL_DEFINITION,
    SHELL_BG_TOOL_DEFINITION,
    SHELL_STATUS_TOOL_DEFINITION,
    SHELL_KILL_TOOL_DEFINITION,
  ];
  if (opts.webSearch) {
    tools.push({ type: "web_search_20260209", name: "web_search" });
  }
  return tools;
}

export async function dispatchTool(name: string, input: unknown): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
  }
  const parsed = handler.schema.safeParse(input);
  if (!parsed.success) {
    return JSON.stringify({
      ok: false,
      error: `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    });
  }
  try {
    const result = await handler.run(parsed.data);
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: `tool execution failed: ${msg}` });
  }
}

export function toolNames(): string[] {
  return Object.keys(HANDLERS);
}

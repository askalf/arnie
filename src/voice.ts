import { spawn } from "node:child_process";
import process from "node:process";

interface VoiceCommand {
  cmd: string;
  args: (text: string) => string[];
  stdin?: boolean;
}

function pickCommand(): VoiceCommand | null {
  if (process.platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: () => [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())",
      ],
      stdin: true,
    };
  }
  if (process.platform === "darwin") {
    return { cmd: "say", args: () => [], stdin: true };
  }
  // Linux: prefer espeak then espeak-ng then spd-say
  return { cmd: "espeak", args: (t) => [t.slice(0, 4000)] };
}

const command = pickCommand();
let buffer = "";
const SPEECH_MAX = 1500;

function strip(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/[#>*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speak(text: string): void {
  if (!command) return;
  const cleaned = strip(text);
  if (!cleaned) return;
  const trimmed = cleaned.slice(0, SPEECH_MAX);
  try {
    const child = spawn(command.cmd, command.args(trimmed), {
      stdio: command.stdin ? ["pipe", "ignore", "ignore"] : ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    child.on("error", () => {});
    if (command.stdin && child.stdin) {
      child.stdin.write(trimmed);
      child.stdin.end();
    }
  } catch {
    // best-effort
  }
}

export function bufferDelta(delta: string): void {
  buffer += delta;
}

export function flushSpeech(): void {
  if (buffer.length === 0) return;
  speak(buffer);
  buffer = "";
}

export function clearSpeechBuffer(): void {
  buffer = "";
}

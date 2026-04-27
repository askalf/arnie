let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function isQuiet(): boolean {
  return quiet;
}

export function log(...args: unknown[]): void {
  if (quiet) return;
  console.log(...args);
}

export function logErr(...args: unknown[]): void {
  console.error(...args);
}

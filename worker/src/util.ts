export function log(scope: string, msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.log(`${new Date().toISOString()} [${scope}] ${msg}${suffix}`);
}

export function parsePrNumber(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null;
  const m = /\/pull\/(\d+)/.exec(prUrl);
  return m && m[1] ? Number(m[1]) : null;
}

/** Last n characters of text. */
export function tailChars(text: string, n: number): string {
  return text.length <= n ? text : text.slice(text.length - n);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Poll pred until true or timeout; returns whether it became true. */
export async function waitUntil(
  pred: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

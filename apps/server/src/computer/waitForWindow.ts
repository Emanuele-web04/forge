import { setTimeout as delay } from "node:timers/promises";
import type { ComputerWindow } from "@synara/contracts";

/** Match an app name/path conservatively; ambiguity never picks a window. */
export async function waitForWindow(
  read: () => Promise<readonly ComputerWindow[]>,
  app: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ComputerWindow | null> {
  const name = app
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.app$/i, "")
    .toLocaleLowerCase();
  const deadline = performance.now() + Math.min(2_000, Math.max(0, timeoutMs));
  while (true) {
    signal?.throwIfAborted();
    const matches = (await read()).filter((window) => window.appName?.toLocaleLowerCase() === name);
    signal?.throwIfAborted();
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    await delay(Math.min(150, remaining), undefined, { signal });
  }
}

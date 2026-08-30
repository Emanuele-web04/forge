import type { ProjectScript } from "@synara/contracts";

import { runProcess } from "./processRunner.ts";
import { buildProviderChildEnvironment } from "./providerChildEnvironment.ts";

const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60_000;

export function findWorktreeSetupScript(
  scripts: ReadonlyArray<ProjectScript>,
): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

/** Run the project's configured setup command in a freshly-created worktree. */
export async function runWorktreeSetupScript(
  scripts: ReadonlyArray<ProjectScript>,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const script = findWorktreeSetupScript(scripts);
  if (!script) return;

  const shell =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", script.command] : ["-lc", script.command];
  await runProcess(shell, args, {
    cwd,
    env: buildProviderChildEnvironment({ provider: "worktree-setup" }),
    timeoutMs: WORKTREE_SETUP_TIMEOUT_MS,
    maxBufferBytes: 8 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
}

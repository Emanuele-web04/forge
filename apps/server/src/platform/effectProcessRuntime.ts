// FILE: effectProcessRuntime.ts
// Purpose: Builds Effect child-process commands from the shared platform planner.
// Layer: Server platform runtime

import { prepareProcess, type ProcessLaunchInput } from "@synara/shared/platformProcess";
import { ChildProcess } from "effect/unstable/process";

type ProcessPlanningOptions = Pick<ProcessLaunchInput, "platform">;

export type EffectProcessRuntimeOptions = Omit<
  ChildProcess.CommandOptions,
  "shell" | "windowsVerbatimArguments"
> &
  ProcessPlanningOptions;

/**
 * Creates an Effect command without leaking `.cmd`, `cmd.exe`, WSL, or
 * windowsVerbatimArguments decisions into provider/application code.
 *
 * Unlike the Node runtime there is deliberately no `requireExecutable`: the
 * Effect spawner is injectable, so a missing executable surfaces as the
 * spawner's own ENOENT error in the owning domain rather than a pre-spawn throw.
 */
export function makeEffectProcessCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions = {},
): ReturnType<typeof ChildProcess.make> {
  const { platform, ...commandOptions } = options;
  const effectivePlatform = platform ?? process.platform;

  // Effect's ChildProcessSpawner is injectable. Keep executable existence and
  // POSIX PATH resolution behind that seam so test/runtime spawners receive the
  // logical command and can translate spawn failures in their owning domain.
  // Windows still needs centralized launch planning for PATHEXT, batch shims,
  // PowerShell scripts, and WSL dispatch before the spawner receives the command.
  if (effectivePlatform !== "win32") {
    return ChildProcess.make(command, [...args], {
      ...commandOptions,
      shell: false,
    });
  }

  const cwd = typeof commandOptions.cwd === "string" ? commandOptions.cwd : undefined;
  const env = commandOptions.env as NodeJS.ProcessEnv | undefined;
  const plan = prepareProcess(command, args, {
    platform: effectivePlatform,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
  });

  return ChildProcess.make(plan.command, plan.args, {
    ...commandOptions,
    shell: false,
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

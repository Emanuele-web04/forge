// FILE: effectProcessRuntime.ts
// Purpose: Builds Effect child-process commands from the shared platform planner.
// Layer: Server platform runtime

import { prepareProcess, type ProcessLaunchInput } from "@synara/shared/platformProcess";
import { ChildProcess } from "effect/unstable/process";

type ProcessPlanningOptions = Pick<ProcessLaunchInput, "platform" | "requireExecutable">;

export type EffectProcessRuntimeOptions = Omit<
  ChildProcess.CommandOptions,
  "shell" | "windowsVerbatimArguments"
> &
  ProcessPlanningOptions;

/**
 * Creates an Effect command without leaking `.cmd`, `cmd.exe`, WSL, or
 * windowsVerbatimArguments decisions into provider/application code.
 */
export function makeEffectProcessCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions = {},
): ReturnType<typeof ChildProcess.make> {
  const { platform, requireExecutable, ...commandOptions } = options;
  const cwd = typeof commandOptions.cwd === "string" ? commandOptions.cwd : undefined;
  const env = commandOptions.env as NodeJS.ProcessEnv | undefined;
  const plan = prepareProcess(command, args, {
    ...(platform !== undefined ? { platform } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(requireExecutable !== undefined ? { requireExecutable } : {}),
  });

  return ChildProcess.make(plan.command, plan.args, {
    ...commandOptions,
    shell: false,
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

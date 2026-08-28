// FILE: gitInvocationSecurity.ts
// Purpose: Applies process-scoped Git config overrides that prevent repository
//          configuration from launching filesystem-monitor commands.
// Layer: Server Git process security

const GIT_HARDENED_CONFIG_ENTRIES = [
  ["core.fsmonitor", "false"],
] as const;

export const GIT_HARDENED_CONFIG_ARGS: ReadonlyArray<string> = Object.freeze(
  GIT_HARDENED_CONFIG_ENTRIES.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
);

export function hardenGitInvocationArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...GIT_HARDENED_CONFIG_ARGS, ...args];
}

/**
 * Environment form for commands such as `gh` that launch Git as a descendant.
 * GIT_CONFIG_COUNT makes the same overrides apply without relying on argument
 * placement or persisting them into the user's repository config.
 */
export function gitHardenedConfigEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(GIT_HARDENED_CONFIG_ENTRIES.length),
  };
  GIT_HARDENED_CONFIG_ENTRIES.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

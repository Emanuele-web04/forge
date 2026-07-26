// FILE: sshRemote.ts
// Purpose: Turn a project's SSH target plus a local agent-CLI invocation into the ssh(1)
//          command that runs that CLI on the remote host over the same stdio contract.
// Layer: Shared domain helper (pure; no process/filesystem access)
// Exports: project remote predicates, POSIX quoting, remote script assembly, ssh argv assembly

import type { ProjectRemote, ProviderKind, ProviderStartOptions } from "@synara/contracts";

/**
 * Providers whose runtime Synara can currently launch on another host.
 *
 * The Claude Agent SDK exposes a documented spawn seam (`spawnClaudeCodeProcess`) that
 * takes over process creation while keeping the stdio protocol intact, which is exactly
 * what an ssh wrapper needs. The other adapters own their process creation internally or
 * speak over a local HTTP/socket runtime, so pointing them at a remote workspace root
 * would silently run them against a path that does not exist on this machine.
 */
const REMOTE_EXECUTION_PROVIDERS: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  "claudeAgent",
]);

export function supportsRemoteExecution(provider: ProviderKind): boolean {
  return REMOTE_EXECUTION_PROVIDERS.has(provider);
}

/**
 * ssh drops a connection that stops answering only after these keepalives fail. An agent
 * turn can legitimately stay silent for minutes, so a plain TCP stall is indistinguishable
 * from thinking without them — the session would hang until the OS gave up (hours).
 * ~90s to a hard failure is short enough to surface as a session error while being far
 * outside any normal quiet period.
 */
const SSH_KEEPALIVE_OPTIONS: ReadonlyArray<string> = [
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
];

/**
 * Environment the *local* ssh process needs to authenticate as the user's terminal does:
 * their config and keys (`HOME`), a running agent (`SSH_AUTH_SOCK`), ssh itself (`PATH`),
 * and a graphical passphrase prompt when one is configured (`DISPLAY`/`SSH_ASKPASS`).
 * Everything else in the provider environment describes *this* machine and would be
 * misleading on the far end, so it is dropped rather than forwarded.
 */
const LOCAL_SSH_ENV_KEYS: ReadonlyArray<string> = [
  "DISPLAY",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSH_AUTH_SOCK",
  "USER",
];

export interface ProjectRemoteHolder {
  readonly remote?: ProjectRemote | null | undefined;
}

/** True when the project's workspace lives on another host rather than this filesystem. */
export function isRemoteProject(project: ProjectRemoteHolder | null | undefined): boolean {
  return resolveProjectRemote(project) !== null;
}

export function resolveProjectRemote(
  project: ProjectRemoteHolder | null | undefined,
): ProjectRemote | null {
  const remote = project?.remote;
  return remote && remote.host.trim().length > 0 ? remote : null;
}

/**
 * Folds a project's SSH target into the server-owned launch options.
 *
 * Only the Claude adapter runs remotely today (see `supportsRemoteExecution`); the other
 * providers keep their local options untouched and are refused before session start.
 */
export function withProjectRemoteStartOptions(
  options: ProviderStartOptions,
  remote: ProjectRemote | null,
): ProviderStartOptions {
  if (!remote) {
    return options;
  }
  return {
    ...options,
    claudeAgent: {
      ...options.claudeAgent,
      remote,
    },
  };
}

/** Human-readable target for UI badges and error messages, e.g. `deploy@box:/srv/app`. */
export function describeProjectRemote(remote: ProjectRemote, workspaceRoot?: string): string {
  return workspaceRoot ? `${remote.host}:${workspaceRoot}` : remote.host;
}

/**
 * Wraps a value so a POSIX shell reads it back as one literal argument. Single quotes
 * suppress every expansion, so the only character needing care is the closing quote
 * itself, which is spliced in as an escaped literal.
 */
export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Splits a typed ssh option string into argv entries, honouring quotes so options whose
 * value contains spaces survive (`-o "ProxyCommand=nc %h %p"`). The result is passed to
 * `execve`, never to a shell, so quoting here is about faithfulness rather than safety.
 */
export function parseSshArgs(value: string): ReadonlyArray<string> {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of value) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    args.push(current);
  }
  return args;
}

export interface RemoteShellScriptInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | null | undefined;
  readonly shellInit?: string | null | undefined;
  /** Forwarded verbatim to the remote; every value is quoted before it reaches the shell. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/**
 * Builds the single command string ssh hands to the remote login shell.
 *
 * Steps are chained with `&&` so a failed `cd` or `shellInit` fails the session loudly
 * instead of silently running the agent in the wrong directory. `exec` makes the agent
 * the shell's own process, so ssh's connection teardown reaches the agent directly and
 * no wrapper shell survives the CLI.
 */
export function buildRemoteShellScript(input: RemoteShellScriptInput): string {
  const steps: string[] = [];
  const cwd = input.cwd?.trim();
  if (cwd) {
    steps.push(`cd ${quotePosixShellArgument(cwd)}`);
  }
  const shellInit = input.shellInit?.trim();
  if (shellInit) {
    steps.push(shellInit);
  }
  const envAssignments = Object.entries(input.env ?? {}).map(
    ([name, value]) => `${name}=${quotePosixShellArgument(value)}`,
  );
  const invocation = [input.command, ...input.args].map(quotePosixShellArgument).join(" ");
  steps.push(
    envAssignments.length > 0
      ? `exec env ${envAssignments.join(" ")} ${invocation}`
      : `exec ${invocation}`,
  );
  return steps.join(" && ");
}

export interface SshRemoteSpawnInput extends RemoteShellScriptInput {
  readonly remote: ProjectRemote;
  /**
   * Loopback ports on this machine the remote agent must be able to call back on
   * (the Synara agent gateway). Forwarded with the same port number on both ends so
   * a `http://127.0.0.1:<port>` endpoint URL resolves identically there.
   */
  readonly reverseLoopbackPorts?: ReadonlyArray<number> | undefined;
}

export interface SshRemoteSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Assembles the local `ssh` invocation for one remote agent process.
 *
 * User-supplied `sshArgs` come first on purpose: ssh keeps the *first* value it sees for
 * any given option, so a user's `-o ServerAliveInterval=...` overrides Synara's default
 * rather than being silently ignored behind it.
 */
export function buildSshRemoteSpawn(input: SshRemoteSpawnInput): SshRemoteSpawn {
  const reverseForwards = (input.reverseLoopbackPorts ?? []).flatMap((port) => [
    "-R",
    `${port}:127.0.0.1:${port}`,
  ]);
  return {
    command: "ssh",
    args: [
      // No pty: the agent protocol is newline-delimited JSON over stdio, and a pty would
      // echo input back and rewrap output.
      "-T",
      ...(input.remote.sshArgs ?? []),
      ...SSH_KEEPALIVE_OPTIONS,
      ...reverseForwards,
      input.remote.host,
      buildRemoteShellScript(input),
    ],
  };
}

/**
 * Narrows a provider child environment down to what the local ssh client needs. Remote
 * process environment is the remote login shell's business (see `ProjectRemote.shellInit`).
 */
export function buildLocalSshProcessEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of LOCAL_SSH_ENV_KEYS) {
    if (env[key] !== undefined) {
      result[key] = env[key];
    }
  }
  return result;
}

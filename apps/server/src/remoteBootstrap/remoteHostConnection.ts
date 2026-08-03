// FILE: remoteHostConnection.ts
// Purpose: A RemoteConnection backed by a saved RemoteHostConfig, so the
//          bootstrapper reaches a host through exactly the same validated ssh
//          invocation the rest of the feature uses.
// Layer: Server / remote broker
// Exports: createRemoteHostConnection, sshOptionArgvFor
//
// Why not `createSshConnection`
// -----------------------------
// That one models a target as `user` + `host`, which cannot express a bare
// `~/.ssh/config` Host alias — and an alias is the documented escape hatch for
// ProxyJump, identity files and everything else we deliberately do not
// re-model (see RemoteHostConfig.destination). Routing through `buildSshArgv`
// keeps ONE construction site for ssh options: BatchMode, host-key policy,
// keepalives and connection reuse are decided there, and `validateSshArgs`
// screens the user's extra arguments on the way through. A second argv builder
// here is exactly how those guarantees drift apart.

import { spawn } from "node:child_process";

import type { RemoteHostConfig } from "@synara/contracts";
import { quotePosixShellArgument } from "@synara/shared/posixShell";
import { buildSshArgv, validateRemoteHostConfig } from "@synara/shared/remoteCommand";

import type { RemoteConnection, RemoteExecOptions, RemoteExecResult } from "./remoteConnection";

const DEFAULT_TIMEOUT_MS = 60_000;

/** Uploads carry a Node runtime over a WAN; they need far longer than a command. */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** Bounds what a chatty or hostile remote can make us buffer per stream. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

type SpawnFn = typeof spawn;

/**
 * The `-o` options `buildSshArgv` decided, without the destination or remote
 * command — the part `scp` needs too.
 *
 * Recovered by splitting the built invocation at its `--` terminator rather
 * than re-deriving the list, so scp and ssh cannot end up under different
 * host-key or BatchMode policies. `buildSshArgv` always appends `--` before the
 * destination, and the empty `remoteArgv` here contributes nothing after it.
 */
export function sshOptionArgvFor(input: {
  readonly config: RemoteHostConfig;
  readonly controlDirectory?: string | undefined;
}): readonly string[] {
  const invocation = buildSshArgv({
    config: input.config,
    remoteArgv: [],
    ...(input.controlDirectory === undefined ? {} : { controlDirectory: input.controlDirectory }),
  });
  const terminator = invocation.args.indexOf("--");
  if (terminator < 0) {
    throw new Error("ssh invocation did not contain an option terminator");
  }
  return invocation.args.slice(0, terminator);
}

function runLocal(
  file: string,
  argv: readonly string[],
  options: RemoteExecOptions | undefined,
  spawnProcess: SpawnFn,
): Promise<RemoteExecResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // argv ARRAY, no shell: nothing in this invocation is ever parsed by one.
    const child = spawnProcess(file, [...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Remote command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, MAX_OUTPUT_BYTES);
    });

    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    child.stdin?.end(options?.stdin ?? "");
  });
}

export interface CreateRemoteHostConnectionInput {
  readonly config: RemoteHostConfig;
  readonly controlDirectory?: string | undefined;
  /** Test seam. */
  readonly spawnProcess?: SpawnFn;
}

/**
 * Builds a connection for a saved host.
 *
 * The config is validated at CONSTRUCTION, so a host that could never produce a
 * legal invocation fails before a single process is spawned rather than at the
 * first exec — which is where the bootstrapper would already have reported
 * progress for a run that cannot happen.
 */
export function createRemoteHostConnection(
  input: CreateRemoteHostConnectionInput,
): RemoteConnection {
  const config = validateRemoteHostConfig(input.config);
  const spawnProcess = input.spawnProcess ?? spawn;
  const optionArgv = sshOptionArgvFor({
    config,
    ...(input.controlDirectory === undefined ? {} : { controlDirectory: input.controlDirectory }),
  });

  const invoke = (remoteArgv: readonly string[], options?: RemoteExecOptions) => {
    const invocation = buildSshArgv({
      config,
      remoteArgv,
      ...(input.controlDirectory === undefined ? {} : { controlDirectory: input.controlDirectory }),
    });
    return runLocal(invocation.command, invocation.args, options, spawnProcess);
  };

  return {
    describe: config.destination,
    exec(argv, options) {
      return invoke(argv, options);
    },
    async uploadFile({ localPath, remotePath, mode }) {
      // Upload to a sibling temp path and rename, so an interrupted transfer
      // never leaves truncated bytes at the destination the bootstrapper will
      // later checksum and trust.
      const temporaryPath = `${remotePath}.partial`;
      // scp, NOT bytes over `exec`'s stdin: `RemoteExecResult.stdin` is a
      // string, and the Node runtime is a binary. Any string round trip
      // re-encodes it and the digest check on the far side then fails on a file
      // we corrupted ourselves.
      const result = await runLocal(
        "scp",
        [
          ...optionArgv,
          // Force the SFTP protocol. Legacy scp implements the remote side by
          // running a REMOTE SHELL over the path, so the target below would be
          // shell-interpreted; SFTP transfers the name as data. OpenSSH 9 makes
          // this the default, but we do not get to choose the client's version.
          "-s",
          "--",
          localPath,
          // Quoted regardless, because `-s` only holds if the client honours
          // it: an older scp that ignores the flag still gets a path its shell
          // cannot take apart.
          `${config.destination}:${quotePosixShellArgument(temporaryPath)}`,
        ],
        { timeoutMs: UPLOAD_TIMEOUT_MS },
        spawnProcess,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to upload ${localPath} to ${config.destination}: ${result.stderr.trim()}`,
        );
      }
      if (mode !== undefined) {
        // No `--`: BSD/macOS chmod rejects it, and the temp path is absolute
        // under the install root, so it can never be read as a flag.
        await invoke(["chmod", mode.toString(8).padStart(3, "0"), temporaryPath]);
      }
      const renamed = await invoke(["mv", "--", temporaryPath, remotePath]);
      if (renamed.exitCode !== 0) {
        throw new Error(
          `Failed to place ${remotePath} on ${config.destination}: ${renamed.stderr.trim()}`,
        );
      }
    },
  };
}

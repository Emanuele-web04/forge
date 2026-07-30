// FILE: remoteConnection.ts
// Purpose: The narrow contract the bootstrapper needs from a remote host —
//          "run this argv" and "copy this local file there". Deliberately two
//          methods so it can be re-implemented on top of the multiplexed SSH
//          connection layer (#8) without touching a line of bootstrap logic.
// Layer: Server / remote broker
// Exports: RemoteConnection, RemoteExecResult, RemoteExecOptions,
//          RemoteCommandError, expectRemoteSuccess

/**
 * Result of running one argv on the remote host.
 *
 * `exitCode` is null when the remote process was killed by a signal, which the
 * callers must treat as a failure and never as "no news is good news".
 */
export interface RemoteExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RemoteExecOptions {
  /** Bytes written to the remote process's stdin, then closed. */
  readonly stdin?: string;
  /** Hard wall-clock limit; the implementation must kill the remote process. */
  readonly timeoutMs?: number;
}

/**
 * A remote host we can act on.
 *
 * Contract notes that every implementation must honour:
 * - `exec` takes an argv VECTOR. Implementations that ultimately hand a string
 *   to a remote login shell (plain `ssh host cmd` does) must encode the vector
 *   with `quotePosixShellCommand`. No caller ever builds a command string.
 * - `uploadFile` writes to `remotePath` and must not leave a partially written
 *   file at that path if it fails: write to a sibling temp path and rename.
 */
export interface RemoteConnection {
  /** Stable, non-secret identifier for logs and errors (e.g. `user@host`). */
  readonly describe: string;
  exec(argv: ReadonlyArray<string>, options?: RemoteExecOptions): Promise<RemoteExecResult>;
  uploadFile(input: {
    readonly localPath: string;
    readonly remotePath: string;
    /** POSIX mode for the destination, e.g. 0o700 for the node binary. */
    readonly mode?: number;
  }): Promise<void>;
}

export class RemoteCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(input: {
    readonly host: string;
    readonly argv: ReadonlyArray<string>;
    readonly result: RemoteExecResult;
  }) {
    // The argv is safe to surface: bootstrap argv never carries credentials
    // (secrets are passed on stdin, never as arguments, precisely so that they
    // stay out of error text and the remote process table).
    super(
      `Remote command failed on ${input.host} (exit ${input.result.exitCode ?? "signal"}): ${input.argv.join(" ")}`,
    );
    this.name = "RemoteCommandError";
    this.exitCode = input.result.exitCode;
    this.stderr = input.result.stderr;
  }
}

/** Runs an argv and throws unless it exited 0. */
export async function expectRemoteSuccess(
  connection: RemoteConnection,
  argv: ReadonlyArray<string>,
  options?: RemoteExecOptions,
): Promise<RemoteExecResult> {
  const result = await connection.exec(argv, options);
  if (result.exitCode !== 0) {
    throw new RemoteCommandError({ host: connection.describe, argv, result });
  }
  return result;
}

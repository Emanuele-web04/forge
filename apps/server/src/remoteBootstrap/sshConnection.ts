// FILE: sshConnection.ts
// Purpose: A direct `ssh`/`scp` implementation of RemoteConnection, sufficient
//          to bootstrap a host on its own. It is intentionally the SIMPLEST
//          possible backing for the interface; the multiplexed, probe-validated
//          connection layer replaces this without the bootstrapper noticing.
// Layer: Server / remote broker
// Exports: sshConnectionOptionArgv, SshTarget, createSshConnection
//
// Security posture:
//  - Host-key verification cannot be turned off. There is no option, flag, or
//    config field that produces `StrictHostKeyChecking=no`; the only knob is
//    WHICH known_hosts file is consulted.
//  - Commands are built as argv and encoded with `quotePosixShellCommand`
//    exactly once, at the boundary where OpenSSH is going to hand the payload
//    to a remote login shell regardless of what we do.

import { spawn } from "node:child_process";

import { quotePosixShellArgument, quotePosixShellCommand } from "@synara/shared/posixShell";

import {
  type RemoteConnection,
  type RemoteExecOptions,
  type RemoteExecResult,
} from "./remoteConnection";

export interface SshTarget {
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  /** Absolute path to the identity file; never the key material itself. */
  readonly identityFile?: string;
  /** Absolute path to a known_hosts file. Defaults to OpenSSH's own. */
  readonly knownHostsFile?: string;
  /**
   * Whether an unknown host key may be accepted and recorded on first contact.
   *
   * This is `accept-new`, NOT `no`: an unknown key is pinned once, and a
   * CHANGED key still fails hard. Turning verification off entirely is not
   * representable in this type by design.
   */
  readonly trustOnFirstUse?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Sinks that make a known_hosts file forget every key it is told to remember.
 *
 * OpenSSH treats `none` as "no known_hosts at all", and /dev/null discards
 * writes, so either one turns `accept-new` from trust-on-first-use into
 * trust-on-EVERY-use: nothing is ever pinned, so a CHANGED key never fails, and
 * a repeated man-in-the-middle can impersonate the host, capture the credential
 * we upload, and answer the provisioning handshake convincingly. There is no
 * legitimate reason to bootstrap against an unpinnable host.
 */
const NON_PERSISTENT_KNOWN_HOSTS: ReadonlySet<string> = new Set([
  "none",
  "/dev/null",
  "/dev/zero",
  "nul",
  "null",
]);

/**
 * A hostname or username must never be readable as an OPTION.
 *
 * `ssh -oProxyCommand=touch\ /tmp/pwned host cmd` runs that command on the
 * LOCAL machine before any connection is attempted, and OpenSSH parses a
 * leading-dash destination exactly that way. This is verified behaviour, not a
 * theoretical concern. Two defences, because either alone is fragile: values are
 * restricted to the characters a hostname and a POSIX username may contain, and
 * every invocation passes `--` before the destination.
 *
 * The allowlist is deliberate. `SshTarget` has no field that can carry a raw ssh
 * flag — no config file, no ProxyCommand, no ControlPath — so the only way one
 * could reach argv is smuggled inside one of these values.
 */
const SSH_HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function assertSshHost(host: string): string {
  const trimmed = host.trim();
  if (!SSH_HOST_PATTERN.test(trimmed) || trimmed.length > 253) {
    throw new Error(`Invalid remote host: ${JSON.stringify(host)}`);
  }
  return trimmed;
}

export function assertSshUser(user: string): string {
  const trimmed = user.trim();
  if (!SSH_USER_PATTERN.test(trimmed) || trimmed.length > 64) {
    throw new Error(`Invalid remote user: ${JSON.stringify(user)}`);
  }
  return trimmed;
}

/**
 * An identity file is passed as `-i <path>`, so a leading dash would be read as
 * the next flag rather than as this one's value.
 */
export function assertSshIdentityFile(identityFile: string): string {
  const trimmed = identityFile.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    throw new Error(`Invalid remote identity file: ${JSON.stringify(identityFile)}`);
  }
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~/")) {
    throw new Error(
      `Remote identity file must be an absolute path: ${JSON.stringify(identityFile)}`,
    );
  }
  return trimmed;
}

export function assertPersistentKnownHostsFile(knownHostsFile: string): string {
  const trimmed = knownHostsFile.trim();
  if (trimmed.length === 0) {
    throw new Error("knownHostsFile must be a path; pass undefined to use OpenSSH's default.");
  }
  if (NON_PERSISTENT_KNOWN_HOSTS.has(trimmed.toLowerCase())) {
    throw new Error(
      `Refusing to use ${trimmed} as a known_hosts file: host keys would never be pinned, which defeats host-key verification.`,
    );
  }
  // A value with whitespace or a newline would split into extra `-o` tokens, or
  // append a second directive to the option OpenSSH parses.
  if (/\s/.test(trimmed)) {
    throw new Error(
      `knownHostsFile must not contain whitespace: ${JSON.stringify(knownHostsFile)}`,
    );
  }
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~/")) {
    throw new Error(`knownHostsFile must be an absolute path: ${JSON.stringify(knownHostsFile)}`);
  }
  return trimmed;
}

/**
 * The `-o` options every ssh/scp invocation carries.
 *
 * `StrictHostKeyChecking` is always emitted explicitly so a permissive value in
 * the user's `~/.ssh/config` cannot silently weaken it — the command line wins.
 */
export function sshConnectionOptionArgv(target: SshTarget): ReadonlyArray<string> {
  const argv: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${target.trustOnFirstUse ? "accept-new" : "yes"}`,
    "-o",
    "ConnectTimeout=15",
  ];
  if (target.knownHostsFile !== undefined) {
    argv.push("-o", `UserKnownHostsFile=${assertPersistentKnownHostsFile(target.knownHostsFile)}`);
  }
  if (target.identityFile !== undefined) {
    argv.push("-o", "IdentitiesOnly=yes", "-i", assertSshIdentityFile(target.identityFile));
  }
  return argv;
}

function describeTarget(target: SshTarget): string {
  return target.port
    ? `${target.user}@${target.host}:${target.port}`
    : `${target.user}@${target.host}`;
}

function runLocal(
  file: string,
  argv: ReadonlyArray<string>,
  options: RemoteExecOptions | undefined,
): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    // `spawn` with an argv array: no shell is involved on the LOCAL side, so a
    // hostile hostname or path cannot inject here.
    const child = spawn(file, [...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
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

    if (options?.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export function createSshConnection(
  target: SshTarget,
  run: typeof runLocal = runLocal,
): RemoteConnection {
  const baseArgv = sshConnectionOptionArgv(target);
  const portArgv = target.port ? ["-p", String(target.port)] : [];
  // Validated here, at construction, so a hostile target fails before a single
  // process is spawned rather than at the first exec.
  const destination = `${assertSshUser(target.user)}@${assertSshHost(target.host)}`;

  return {
    describe: describeTarget(target),
    exec(argv, options) {
      // `ssh host <words>` joins its trailing words with a space and runs the
      // result through the remote login shell. Encoding the argv here is the
      // only correct response; the caller never sees a command string.
      // `--` before the destination: belt and braces with the host/user
      // validation above, so a leading-dash value can never be read as an
      // option (notably -oProxyCommand=, which executes LOCALLY).
      return run(
        "ssh",
        [...baseArgv, ...portArgv, "--", destination, quotePosixShellCommand(argv)],
        options,
      );
    },
    async uploadFile({ localPath, remotePath, mode }) {
      // Upload to a sibling temp path and rename, so an interrupted transfer
      // never leaves truncated bytes at the destination the bootstrapper will
      // later checksum and trust.
      const temporaryPath = `${remotePath}.partial`;
      const scpPortArgv = target.port ? ["-P", String(target.port)] : [];
      const result = await run(
        "scp",
        [
          ...baseArgv,
          ...scpPortArgv,
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
          `${destination}:${quotePosixShellArgument(temporaryPath)}`,
        ],
        undefined,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to upload ${localPath} to ${describeTarget(target)}: ${result.stderr.trim()}`,
        );
      }
      if (mode !== undefined) {
        const chmod = await this.exec([
          "chmod",
          mode.toString(8).padStart(3, "0"),
          "--",
          temporaryPath,
        ]);
        if (chmod.exitCode !== 0) {
          throw new Error(`Failed to set mode on ${remotePath}: ${chmod.stderr.trim()}`);
        }
      }
      const moved = await this.exec(["mv", "--", temporaryPath, remotePath]);
      if (moved.exitCode !== 0) {
        throw new Error(`Failed to finalize ${remotePath}: ${moved.stderr.trim()}`);
      }
    },
  };
}

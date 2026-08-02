// FILE: sshTunnel.ts
// Purpose: Hold an SSH local-forward open from a loopback port on this machine
//          to the remote server's own loopback port, and make its death
//          observable. This is the ONLY way bytes reach a remote Synara: the
//          browser talks to `/env/:envId/*` on the local origin, the proxy
//          connects to the near end of this forward, and nothing anywhere
//          addresses the remote host directly.
// Layer: Server / remote broker
// Exports: openSshTunnel, SshTunnel, SshTunnelError, reserveLoopbackPort,
//          releaseReservedPort
//
// Lifetime model
// --------------
// `-N` means the ssh child runs no remote command, so the child's lifetime IS
// the tunnel's lifetime. That is deliberate: it gives exactly one thing to
// watch. When the child exits for any reason — network death, the remote
// sshd restarting, someone killing it — `onClosed` fires once and the caller
// retracts the environment. There is no second, quieter failure mode where the
// process lives on with a forward that no longer forwards, because
// `ExitOnForwardFailure=yes` turns that state into an exit too.
//
// Teardown must be deterministic on BOTH paths — a failed open and an explicit
// close — because the thing being leaked is an OS process holding a network
// connection, and a leaked one is invisible until the machine runs out of
// something. `close()` is therefore idempotent, waits for the child to actually
// go away, and escalates to SIGKILL rather than trusting SIGTERM.

import { spawn, type ChildProcess } from "node:child_process";
import * as Net from "node:net";

import type { RemoteHostConfig } from "@synara/contracts";
import { buildSshTunnelArgv, TUNNEL_LOOPBACK_ADDRESS } from "@synara/shared/remoteCommand";

export class SshTunnelError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(message);
    this.name = "SshTunnelError";
    this.stderr = stderr;
  }
}

/**
 * Ports this process has handed out but whose ssh child has not yet bound them.
 *
 * The kernel's "give me a free port" answer is only true at the instant it is
 * given: between closing the probe socket and ssh binding the port, anything on
 * the machine may take it. That window cannot be closed with ssh — it takes a
 * port number, not an inherited socket — so it is NARROWED (the probe socket is
 * closed as late as possible) and DETECTED (`ExitOnForwardFailure` makes a lost
 * race an immediate, reported exit rather than a silent half-tunnel).
 *
 * This set closes the part that IS ours to close: two tunnels opening
 * concurrently in this process would otherwise be told about the same free port
 * by two probes and the second would always lose.
 */
const reservedPorts = new Set<number>();

/** Test seam and cleanup: drops a port back into the pool. */
export function releaseReservedPort(port: number): void {
  reservedPorts.delete(port);
}

/**
 * Asks the kernel for an unused loopback port.
 *
 * Binds `127.0.0.1` explicitly rather than the wildcard: a wildcard bind can
 * succeed on a port that is already taken on loopback specifically, and
 * loopback is the only interface the forward will use.
 *
 * Separate from the bookkeeping below so the collision branch is reachable in a
 * test. It is NOT otherwise: the kernel almost never re-offers a port it just
 * handed out, so a test that only opens many reservations at once passes
 * whether or not the collision check exists — verified by mutation.
 */
export type LoopbackPortSource = () => Promise<number>;

const kernelLoopbackPort: LoopbackPortSource = () =>
  new Promise((resolve, reject) => {
    const probe = Net.createServer();
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      run();
    };

    probe.once("error", (cause) =>
      settle(() =>
        reject(new SshTunnelError(`Failed to reserve a loopback port: ${String(cause)}`)),
      ),
    );
    probe.listen(0, TUNNEL_LOOPBACK_ADDRESS, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() =>
        settle(() => {
          if (port > 0) resolve(port);
          else reject(new SshTunnelError("Failed to reserve a loopback port."));
        }),
      );
    });
  });

/**
 * Reserve a loopback port that no other in-flight tunnel in this process holds.
 *
 * The kernel's answer is only true at the instant it is given, and it does not
 * know about ports we have promised but not yet bound — so two tunnels opening
 * together would otherwise be handed the same number and the second would
 * always lose the race to bind it.
 */
export async function reserveLoopbackPort(
  attempts = 8,
  source: LoopbackPortSource = kernelLoopbackPort,
): Promise<number> {
  for (let remaining = attempts; remaining > 0; remaining -= 1) {
    const port = await source();
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new SshTunnelError("Could not find a free loopback port for the tunnel.");
}

export interface SshTunnel {
  /** Loopback port on THIS machine. The proxy's upstream. */
  readonly localPort: number;
  readonly remotePort: number;
  /**
   * Resolves once the child is gone. Idempotent, and safe to call from a
   * failure path that may or may not have started the child.
   */
  close(): Promise<void>;
  /** True until the child has exited or `close()` completed. */
  readonly alive: boolean;
}

export interface OpenSshTunnelInput {
  readonly config: RemoteHostConfig;
  readonly remotePort: number;
  readonly controlDirectory?: string | undefined;
  /**
   * Fires exactly once when the tunnel stops carrying traffic, whether that was
   * an explicit `close()` or the connection dying. `expected` distinguishes the
   * two so the caller can retract an environment on the second without
   * reporting an error on the first.
   */
  readonly onClosed?: (info: { readonly expected: boolean; readonly detail: string }) => void;
  /** How long ssh may take to establish the forward before we give up. */
  readonly readyTimeoutMs?: number;
  /** Test seam. */
  readonly spawnProcess?: typeof spawn;
}

/** How long to wait for SIGTERM before escalating. */
const TERMINATE_GRACE_MS = 2_000;

/**
 * Ceiling on how long the forward may take to come up.
 *
 * Independent of ssh's own ConnectTimeout, which only covers the TCP connect:
 * authentication, key exchange and the forward request all happen after it, and
 * a host that accepts a connection and then stalls would otherwise hold the
 * open forever.
 */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** How long to wait for the local port to answer before polling again. */
const READY_POLL_INTERVAL_MS = 100;

/** Probes the near end: the forward is up when something accepts on it. */
function localPortAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = Net.connect({ host: TUNNEL_LOOPBACK_ADDRESS, port });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(READY_POLL_INTERVAL_MS * 5, () => settle(false));
  });
}

/**
 * Opens the forward and resolves only once it actually carries a connection.
 *
 * Resolving on spawn would be a lie: ssh has not authenticated, let alone bound
 * the port, and the caller would publish an environment whose first request is
 * refused. So the near end is PROBED, and the open fails if it never answers.
 *
 * Every exit path — spawn error, ssh exiting early, the readiness deadline —
 * runs the same teardown, so there is no arrangement of failures that leaves
 * the child running after this function has rejected.
 */
export async function openSshTunnel(input: OpenSshTunnelInput): Promise<SshTunnel> {
  const localPort = await reserveLoopbackPort();
  const invocation = buildSshTunnelArgv({
    config: input.config,
    localPort,
    remotePort: input.remotePort,
    ...(input.controlDirectory === undefined
      ? {}
      : { controlDirectory: input.controlDirectory }),
  });

  let child: ChildProcess;
  try {
    // argv ARRAY, no shell: nothing in the invocation is ever parsed by one.
    child = (input.spawnProcess ?? spawn)(invocation.command, [...invocation.args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (cause) {
    releaseReservedPort(localPort);
    throw new SshTunnelError(`Failed to start ssh for the tunnel: ${String(cause)}`);
  }

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    // Bounded: a chatty ssh must not grow this without limit for the whole
    // lifetime of a tunnel that may be up for days.
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  let exited = false;
  let exitDetail = "";
  let closeRequested = false;
  let closedNotified = false;

  const notifyClosed = (expected: boolean, detail: string) => {
    if (closedNotified) return;
    closedNotified = true;
    input.onClosed?.({ expected, detail });
  };

  const exitPromise = new Promise<void>((resolve) => {
    const finish = (detail: string) => {
      if (exited) return;
      exited = true;
      exitDetail = detail;
      releaseReservedPort(localPort);
      resolve();
    };
    child.once("exit", (code, signal) => {
      finish(signal ? `ssh was killed by ${signal}` : `ssh exited with code ${code}`);
      // An exit we did not ask for is the tunnel dying. Reported here rather
      // than only in close(), because the common case is nobody calling close()
      // at all — the network went away and the caller needs to hear it.
      notifyClosed(closeRequested, exitDetail);
    });
    child.once("error", (cause) => {
      finish(`ssh could not run: ${String(cause)}`);
      notifyClosed(closeRequested, exitDetail);
    });
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Idempotent by memoising the FIRST teardown, so concurrent callers await
    // one process death rather than racing two kill sequences.
    closing ??= (async () => {
      closeRequested = true;
      if (exited) {
        notifyClosed(true, exitDetail);
        return;
      }
      child.kill("SIGTERM");
      const escalation = setTimeout(() => {
        // ssh holding a half-dead connection can ignore SIGTERM. A tunnel we
        // decided to close must be gone, so this is not optional.
        if (!exited) child.kill("SIGKILL");
      }, TERMINATE_GRACE_MS);
      // `unref` so a pending escalation cannot keep the process alive.
      escalation.unref?.();
      try {
        await exitPromise;
      } finally {
        clearTimeout(escalation);
      }
      notifyClosed(true, exitDetail);
    })();
    return closing;
  };

  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exited) {
      // ExitOnForwardFailure makes a refused or already-taken local port an
      // exit, so this is also where a lost port race surfaces.
      await close();
      throw new SshTunnelError(
        `The SSH tunnel to ${input.config.destination} closed before it was ready (${exitDetail}).`,
        stderr,
      );
    }
    if (await localPortAccepts(localPort)) break;
    if (Date.now() >= deadline) {
      await close();
      throw new SshTunnelError(
        `The SSH tunnel to ${input.config.destination} did not come up within ${readyTimeoutMs}ms.`,
        stderr,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }

  return {
    localPort,
    remotePort: input.remotePort,
    close,
    get alive() {
      return !exited;
    },
  };
}

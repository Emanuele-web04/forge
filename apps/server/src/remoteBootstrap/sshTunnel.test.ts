import * as Net from "node:net";

import type { RemoteHostConfig } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  openSshTunnel,
  releaseReservedPort,
  reserveLoopbackPort,
  SshTunnelError,
} from "./sshTunnel";

function makeConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1",
    label: "Build box",
    destination: "build-box",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 5,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: false, persistSeconds: 300 },
    launcher: { kind: "direct" },
    binaryPath: "/usr/local/bin/claude",
    ...overrides,
  } as RemoteHostConfig;
}

/**
 * A stand-in for `ssh -L`: a process that, like the real one, holds a listener
 * open on the forwarded port for exactly as long as it lives. `node -e` is used
 * rather than a mock object because the properties under test — that the child
 * is really gone after close(), that a SIGTERM-ignoring child is still killed —
 * are properties of an OS process, and a fake would assert them of itself.
 */
function fakeSshSpawner(script: (localPort: number) => string) {
  const spawned: Array<import("node:child_process").ChildProcess> = [];
  const spawn = ((_command: string, args: readonly string[], options: unknown) => {
    const { spawn: realSpawn } =
      require("node:child_process") as typeof import("node:child_process");
    // Recover the port from the forward spec we built: `127.0.0.1:L:127.0.0.1:R`.
    const spec = args[args.indexOf("-L") + 1] as string;
    const localPort = Number(spec.split(":")[1]);
    const child = realSpawn(process.execPath, ["-e", script(localPort)], options as never);
    spawned.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, spawned };
}

/** Listens on the forwarded port and stays up until killed. */
const LISTEN_FOREVER = (port: number) =>
  `require("node:net").createServer().listen(${port},"127.0.0.1");setInterval(()=>{},1e9)`;

/** Listens, but ignores SIGTERM — the shape that needs SIGKILL escalation. */
const IGNORE_SIGTERM = (port: number) =>
  `process.on("SIGTERM",()=>{});require("node:net").createServer().listen(${port},"127.0.0.1");setInterval(()=>{},1e9)`;

/** Exits immediately without ever binding — ExitOnForwardFailure's shape. */
const EXIT_IMMEDIATELY = () => `process.exit(3)`;

/** Never binds, never exits — the "connected but no forward" hang. */
const NEVER_BIND = () => `setInterval(()=>{},1e9)`;

const openTunnels: Array<{ close(): Promise<void> }> = [];
const strays: Array<import("node:child_process").ChildProcess> = [];

afterEach(async () => {
  for (const tunnel of openTunnels.splice(0)) await tunnel.close();
  for (const child of strays.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("reserveLoopbackPort", () => {
  it("never hands the same port to two concurrent reservations", async () => {
    const ports = await Promise.all(Array.from({ length: 16 }, () => reserveLoopbackPort()));
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) releaseReservedPort(port);
  });

  /**
   * The collision branch, driven directly. The concurrency test above passes
   * whether or not the check exists — the kernel almost never re-offers a port
   * it just handed out — so a source that DOES re-offer one is the only way to
   * pin the behaviour. Found by mutation: disabling the check left that test
   * green.
   */
  it("asks again when the kernel re-offers a port another tunnel already holds", async () => {
    const held = await reserveLoopbackPort();
    const offered = [held, held, 45999];
    let index = 0;
    const port = await reserveLoopbackPort(8, async () => offered[index++] as number);
    expect(port).toBe(45999);
    // Both duplicates were rejected rather than handed out a second time.
    expect(index).toBe(3);
    releaseReservedPort(held);
    releaseReservedPort(port);
  });

  it("gives up rather than hand out a port that is already spoken for", async () => {
    const held = await reserveLoopbackPort();
    await expect(reserveLoopbackPort(3, async () => held)).rejects.toThrow(SshTunnelError);
    releaseReservedPort(held);
  });

  it("releases a port once it is given back, so it can be reused", async () => {
    const port = await reserveLoopbackPort();
    releaseReservedPort(port);
    // Not an assertion about getting the SAME port back — the kernel decides
    // that — only that releasing does not wedge the pool.
    const next = await reserveLoopbackPort();
    expect(Number.isInteger(next)).toBe(true);
    releaseReservedPort(next);
  });
});

describe("openSshTunnel", () => {
  it("resolves only once the local port actually accepts a connection", async () => {
    const { spawn, spawned } = fakeSshSpawner(LISTEN_FOREVER);
    strays.push(...spawned);
    const tunnel = await openSshTunnel({
      config: makeConfig(),
      remotePort: 39100,
      spawnProcess: spawn,
    });
    openTunnels.push(tunnel);
    // Resolving on spawn would be a lie: the caller would publish an
    // environment whose first request is refused.
    await new Promise<void>((resolve, reject) => {
      const socket = Net.connect({ host: "127.0.0.1", port: tunnel.localPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    expect(tunnel.alive).toBe(true);
  });

  /**
   * The teardown path that matters most: an ssh process left behind is
   * invisible until the machine runs out of something.
   */
  it("leaves no ssh process behind after close()", async () => {
    const { spawn, spawned } = fakeSshSpawner(LISTEN_FOREVER);
    const tunnel = await openSshTunnel({
      config: makeConfig(),
      remotePort: 39100,
      spawnProcess: spawn,
    });
    const pid = spawned[0]?.pid;
    expect(pid).toBeDefined();
    expect(isProcessAlive(pid as number)).toBe(true);

    await tunnel.close();

    expect(tunnel.alive).toBe(false);
    expect(await waitUntil(() => !isProcessAlive(pid as number))).toBe(true);
  });

  /**
   * The OTHER teardown path. A failed open that leaves the child running is the
   * same leak, reached from the error branch — which is exactly the branch
   * nobody exercises by hand.
   */
  it("leaves no ssh process behind when the open FAILS to come up", async () => {
    const { spawn, spawned } = fakeSshSpawner(NEVER_BIND);
    strays.push(...spawned);
    await expect(
      openSshTunnel({
        config: makeConfig(),
        remotePort: 39100,
        spawnProcess: spawn,
        readyTimeoutMs: 300,
      }),
    ).rejects.toThrow(SshTunnelError);

    const pid = spawned[0]?.pid;
    expect(pid).toBeDefined();
    expect(await waitUntil(() => !isProcessAlive(pid as number))).toBe(true);
  });

  /**
   * ssh holding a half-dead connection can ignore SIGTERM. A tunnel we decided
   * to close must be gone, so the escalation is not optional.
   */
  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const { spawn, spawned } = fakeSshSpawner(IGNORE_SIGTERM);
    strays.push(...spawned);
    const tunnel = await openSshTunnel({
      config: makeConfig(),
      remotePort: 39100,
      spawnProcess: spawn,
    });
    const pid = spawned[0]?.pid as number;
    await tunnel.close();
    expect(await waitUntil(() => !isProcessAlive(pid))).toBe(true);
  });

  it("reports the ssh child dying as an UNEXPECTED close", async () => {
    const { spawn, spawned } = fakeSshSpawner(LISTEN_FOREVER);
    strays.push(...spawned);
    const closes: Array<{ expected: boolean; detail: string }> = [];
    const tunnel = await openSshTunnel({
      config: makeConfig(),
      remotePort: 39100,
      spawnProcess: spawn,
      onClosed: (info) => closes.push(info),
    });
    openTunnels.push(tunnel);

    // The network went away: nobody called close(), so this is the ONLY signal
    // the caller gets that the environment is no longer reachable.
    spawned[0]?.kill("SIGKILL");

    expect(await waitUntil(() => closes.length > 0)).toBe(true);
    expect(closes[0]?.expected).toBe(false);
    expect(tunnel.alive).toBe(false);
  });

  it("reports an explicit close as EXPECTED, so it is not read as a failure", async () => {
    const { spawn, spawned } = fakeSshSpawner(LISTEN_FOREVER);
    strays.push(...spawned);
    const closes: Array<{ expected: boolean }> = [];
    const tunnel = await openSshTunnel({
      config: makeConfig(),
      remotePort: 39100,
      spawnProcess: spawn,
      onClosed: (info) => closes.push(info),
    });
    await tunnel.close();
    expect(closes).toHaveLength(1);
    expect(closes[0]?.expected).toBe(true);
  });

  it("notifies close exactly once, however many times close() is called", async () => {
    const { spawn, spawned } = fakeSshSpawner(LISTEN_FOREVER);
    strays.push(...spawned);
    const closes: unknown[] = [];
    const tunnel = await openSshTunnel({
      config: makeConfig(),
      remotePort: 39100,
      spawnProcess: spawn,
      onClosed: () => closes.push(1),
    });
    // Concurrent AND sequential: both are real — a teardown racing a dropped
    // connection, and a caller that closes defensively.
    await Promise.all([tunnel.close(), tunnel.close()]);
    await tunnel.close();
    expect(closes).toHaveLength(1);
  });

  it("fails the open when ssh exits before the forward is up", async () => {
    const { spawn, spawned } = fakeSshSpawner(EXIT_IMMEDIATELY);
    strays.push(...spawned);
    await expect(
      openSshTunnel({
        config: makeConfig(),
        remotePort: 39100,
        spawnProcess: spawn,
        readyTimeoutMs: 5_000,
      }),
      // ExitOnForwardFailure makes a lost port race an exit, so this is also
      // the path a taken local port arrives on.
    ).rejects.toThrow(/closed before it was ready/);
  });

  it("refuses to open at all when the config would be refused", async () => {
    const { spawn } = fakeSshSpawner(LISTEN_FOREVER);
    await expect(
      openSshTunnel({
        config: makeConfig({ sshArgs: ["-L", "0.0.0.0:1:evil:22"] }),
        remotePort: 39100,
        spawnProcess: spawn,
      }),
    ).rejects.toThrow();
  });
});

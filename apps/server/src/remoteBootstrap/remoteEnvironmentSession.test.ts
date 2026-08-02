import type { EnvironmentId, RemoteHostConfig } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { EnvironmentProxyUpstream } from "../environmentProxyTargets";
import type { ProvisioningClaim } from "./provisioningHandshake";
import {
  openRemoteEnvironmentSession,
  RemoteEnvironmentSessionError,
} from "./remoteEnvironmentSession";
import type { SshTunnel } from "./sshTunnel";

const ENVIRONMENT_ID = "env-abc" as EnvironmentId;
const CREDENTIAL = { token: "tok-1" };
const SERVER_VERSION = "1.2.3";

function makeConfig(): RemoteHostConfig {
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
  } as RemoteHostConfig;
}

function goodClaim(): ProvisioningClaim {
  return {
    environmentId: ENVIRONMENT_ID,
    serverVersion: SERVER_VERSION,
    acceptedToken: CREDENTIAL.token,
    authenticated: true,
  };
}

/** Records the order of every effect, which is what most of these assert. */
function makeHarness(
  options: {
    readonly claim?: ProvisioningClaim;
    readonly claimError?: Error;
    readonly tunnelError?: Error;
  } = {},
) {
  const events: string[] = [];
  const published: EnvironmentProxyUpstream[] = [];
  let closedTunnels = 0;
  let onClosed: ((info: { expected: boolean; detail: string }) => void) | undefined;

  const openTunnel = (async (tunnelInput: {
    onClosed?: (info: { expected: boolean; detail: string }) => void;
  }) => {
    if (options.tunnelError) throw options.tunnelError;
    onClosed = tunnelInput.onClosed;
    events.push("tunnel-open");
    let alive = true;
    const tunnel: SshTunnel = {
      localPort: 45123,
      remotePort: 39100,
      async close() {
        alive = false;
        closedTunnels += 1;
        events.push("tunnel-close");
      },
      get alive() {
        return alive;
      },
    };
    return tunnel;
  }) as never;

  return {
    events,
    published,
    get closedTunnels() {
      return closedTunnels;
    },
    /** Simulates the tunnel dying on its own. */
    killTunnel(detail = "ssh exited with code 255") {
      onClosed?.({ expected: false, detail });
    },
    input: {
      config: makeConfig(),
      environmentId: ENVIRONMENT_ID,
      credential: CREDENTIAL,
      serverVersion: SERVER_VERSION,
      remotePort: 39100,
      openTunnel,
      probeHandshake: async () => {
        events.push("handshake");
        if (options.claimError) throw options.claimError;
        return options.claim ?? goodClaim();
      },
      publish: (upstream: EnvironmentProxyUpstream) => {
        events.push("publish");
        published.push(upstream);
      },
      retract: () => {
        events.push("retract");
      },
    },
  };
}

describe("openRemoteEnvironmentSession", () => {
  /**
   * The invariant the whole file exists for. Publishing before verifying opens
   * a window in which the browser can reach an unverified server, and there is
   * no acceptable length for that window.
   */
  it("publishes ONLY after the handshake has passed", async () => {
    const harness = makeHarness();
    const session = await openRemoteEnvironmentSession(harness.input);
    expect(harness.events).toEqual(["tunnel-open", "handshake", "publish"]);
    expect(harness.published[0]).toEqual({
      environmentId: ENVIRONMENT_ID,
      host: "127.0.0.1",
      port: 45123,
      credential: CREDENTIAL.token,
    });
    await session.close();
  });

  it("registers the tunnel's near end, never the remote host's address", async () => {
    const harness = makeHarness();
    const session = await openRemoteEnvironmentSession(harness.input);
    // The browser never talks to the remote directly; the proxy only ever
    // connects to loopback.
    expect(harness.published[0]?.host).toBe("127.0.0.1");
    expect(harness.published[0]?.port).toBe(45123);
    await session.close();
  });

  it("publishes nothing and tears the tunnel down when the handshake is refused", async () => {
    const harness = makeHarness({
      claim: { ...goodClaim(), environmentId: "somebody-elses-environment" },
    });
    await expect(openRemoteEnvironmentSession(harness.input)).rejects.toThrow(
      RemoteEnvironmentSessionError,
    );
    expect(harness.events).toEqual(["tunnel-open", "handshake", "tunnel-close"]);
    expect(harness.published).toHaveLength(0);
  });

  it("publishes nothing when the remote echoes a credential we did not provision", async () => {
    const harness = makeHarness({ claim: { ...goodClaim(), acceptedToken: "tok-somebody-else" } });
    await expect(openRemoteEnvironmentSession(harness.input)).rejects.toThrow();
    expect(harness.published).toHaveLength(0);
    expect(harness.closedTunnels).toBe(1);
  });

  it("publishes nothing when the running release is not the one we activated", async () => {
    const harness = makeHarness({ claim: { ...goodClaim(), serverVersion: "9.9.9" } });
    await expect(openRemoteEnvironmentSession(harness.input)).rejects.toThrow();
    expect(harness.published).toHaveLength(0);
    expect(harness.closedTunnels).toBe(1);
  });

  /** A handshake that THREW is no more verified than one that was refused. */
  it("tears the tunnel down when the handshake could not be reached at all", async () => {
    const harness = makeHarness({ claimError: new Error("unreachable") });
    await expect(openRemoteEnvironmentSession(harness.input)).rejects.toThrow("unreachable");
    expect(harness.published).toHaveLength(0);
    expect(harness.closedTunnels).toBe(1);
  });

  /**
   * Retract BEFORE the tunnel goes. The reverse order leaves the proxy holding
   * a registration whose upstream is already dead — every request answering 502
   * rather than 404.
   */
  it("retracts the environment before tearing down the tunnel", async () => {
    const harness = makeHarness();
    const session = await openRemoteEnvironmentSession(harness.input);
    await session.close();
    expect(harness.events).toEqual([
      "tunnel-open",
      "handshake",
      "publish",
      "retract",
      "tunnel-close",
    ]);
  });

  it("retracts and reports when the tunnel dies on its own", async () => {
    const lost: string[] = [];
    const harness = makeHarness();
    await openRemoteEnvironmentSession({
      ...harness.input,
      onLost: (detail) => lost.push(detail),
    });
    harness.killTunnel("ssh exited with code 255");
    // Give the async unwind a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.events).toContain("retract");
    expect(lost).toEqual(["ssh exited with code 255"]);
  });

  it("closes idempotently, retracting exactly once", async () => {
    const harness = makeHarness();
    const session = await openRemoteEnvironmentSession(harness.input);
    await Promise.all([session.close(), session.close()]);
    await session.close();
    expect(harness.events.filter((event) => event === "retract")).toHaveLength(1);
    expect(harness.closedTunnels).toBe(1);
  });

  it("never publishes when the tunnel could not be opened", async () => {
    const harness = makeHarness({ tunnelError: new Error("no route to host") });
    await expect(openRemoteEnvironmentSession(harness.input)).rejects.toThrow("no route to host");
    expect(harness.published).toHaveLength(0);
    expect(harness.events).toEqual([]);
  });
});

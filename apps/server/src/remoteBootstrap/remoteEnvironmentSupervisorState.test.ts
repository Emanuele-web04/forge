import type { RemoteHostConfig, RemoteHostId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  connectionIdentityOf,
  failedStatus,
  planSupervisedHosts,
  statusFor,
  unsupportedStatus,
} from "./remoteEnvironmentSupervisorState";

function hostConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1" as RemoteHostId,
    label: "devbox",
    destination: "devbox",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 10,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: true, persistSeconds: 300 },
    launcher: { kind: "direct" },
    ...overrides,
  } as RemoteHostConfig;
}

describe("planSupervisedHosts", () => {
  it("starts a saved host that is not running", () => {
    const plan = planSupervisedHosts({ saved: [hostConfig()], running: new Map() });
    expect(plan.start.map((config) => config.hostId)).toEqual(["host-1"]);
    expect(plan.restart).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  it("stops a running host that is no longer saved", () => {
    const plan = planSupervisedHosts({
      saved: [],
      running: new Map([["host-1" as RemoteHostId, connectionIdentityOf(hostConfig())]]),
    });
    expect(plan.stop).toEqual(["host-1"]);
    expect(plan.start).toEqual([]);
  });

  it("leaves an unchanged host alone", () => {
    const config = hostConfig();
    const plan = planSupervisedHosts({
      saved: [config],
      running: new Map([["host-1" as RemoteHostId, connectionIdentityOf(config)]]),
    });
    expect(plan.start).toEqual([]);
    expect(plan.restart).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  it("restarts a host whose destination changed", () => {
    // Same id, different machine. Leaving the tunnel up would keep serving the
    // OLD box forever under the new name.
    const plan = planSupervisedHosts({
      saved: [hostConfig({ destination: "other-box" })],
      running: new Map([["host-1" as RemoteHostId, connectionIdentityOf(hostConfig())]]),
    });
    expect(plan.restart.map((config) => config.hostId)).toEqual(["host-1"]);
    expect(plan.start).toEqual([]);
  });

  it("does NOT restart for a rename", () => {
    // A label is display only. Tearing a working tunnel down to rename a row
    // would drop the user's sessions for nothing.
    const config = hostConfig();
    const plan = planSupervisedHosts({
      saved: [hostConfig({ label: "renamed" })],
      running: new Map([["host-1" as RemoteHostId, connectionIdentityOf(config)]]),
    });
    expect(plan.restart).toEqual([]);
    expect(plan.start).toEqual([]);
  });

  it("collapses duplicate ids instead of throwing", () => {
    // Settings are user-editable on disk; a malformed file must not take every
    // other host down with it.
    const plan = planSupervisedHosts({
      saved: [hostConfig(), hostConfig({ destination: "dupe" })],
      running: new Map(),
    });
    expect(plan.start).toHaveLength(1);
    expect(plan.start[0]?.destination).toBe("devbox");
  });
});

describe("status construction", () => {
  it("omits the environment id until one is proven", () => {
    const status = statusFor({
      hostId: "host-1" as RemoteHostId,
      phase: "bootstrapping",
      nowMs: 0,
    });
    expect(status.environmentId).toBeUndefined();
  });

  it("schedules a retry on failure", () => {
    const status = failedStatus({
      hostId: "host-1" as RemoteHostId,
      attempt: 1,
      error: "nope",
      nowMs: 1_000,
      random: () => 0,
    });
    expect(status.phase).toBe("failed");
    expect(status.retryAtMs).toBeGreaterThan(1_000);
  });

  it("never schedules a retry for an unsupported host", () => {
    // No number of attempts turns a darwin box into a systemd one.
    const status = unsupportedStatus({
      hostId: "host-1" as RemoteHostId,
      reason: "launchd bootstrap is not enabled yet",
      nowMs: 0,
    });
    expect(status.phase).toBe("unsupported");
    expect(status.retryAtMs).toBeUndefined();
    expect(status.unsupportedReason).toContain("launchd");
  });
});

import type { RemoteHostId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  applyHealthResult,
  BACKOFF_MAX_MS,
  backoffDelayMs,
  DOWN_FAILURE_THRESHOLD,
  initialConnectivity,
  isHostUsable,
  shouldAttemptNow,
} from "./remoteHostConnectivity";

const HOST = "host-1" as RemoteHostId;

/** Deterministic "random" so backoff assertions are exact. */
const noJitter = () => 0;
const maxJitter = () => 1;

function fail(status = initialConnectivity(HOST, 0), times = 1, startMs = 0) {
  let current = status;
  for (let index = 0; index < times; index += 1) {
    current = applyHealthResult(current, { ok: false, error: "boom" }, startMs + index, noJitter);
  }
  return current;
}

describe("connectivity state machine", () => {
  it("starts reconnecting: a host is not connected until a check proves it", () => {
    expect(initialConnectivity(HOST, 0).state).toBe("reconnecting");
  });

  it("reaches connected on the first successful health check", () => {
    const status = applyHealthResult(initialConnectivity(HOST, 0), { ok: true }, 100);
    expect(status.state).toBe("connected");
    expect(status.consecutiveFailures).toBe(0);
    expect(status.nextAttemptAtMs).toBeUndefined();
  });

  it("degrades on one failure rather than declaring an outage on a blip", () => {
    const connected = applyHealthResult(initialConnectivity(HOST, 0), { ok: true }, 0);
    const degraded = applyHealthResult(connected, { ok: false, error: "blip" }, 10, noJitter);
    expect(degraded.state).toBe("degraded");
    // Degraded still allows work: the pre-start probe is the real gate.
    expect(isHostUsable(degraded)).toBe(true);
  });

  it("escalates degraded to reconnecting to down as failures accumulate", () => {
    let status = applyHealthResult(initialConnectivity(HOST, 0), { ok: true }, 0);
    const seen: string[] = [];
    for (let index = 0; index < DOWN_FAILURE_THRESHOLD; index += 1) {
      status = applyHealthResult(status, { ok: false, error: "boom" }, index, noJitter);
      seen.push(status.state);
    }
    expect(seen).toEqual(["degraded", "reconnecting", "reconnecting", "down"]);
    expect(isHostUsable(status)).toBe(false);
  });

  it("does not let a never-connected host claim it degraded from health", () => {
    const status = applyHealthResult(initialConnectivity(HOST, 0), { ok: false }, 1, noJitter);
    expect(status.state).toBe("reconnecting");
  });

  it("recovers to connected from down on one success", () => {
    const down = fail(initialConnectivity(HOST, 0), DOWN_FAILURE_THRESHOLD + 2);
    expect(down.state).toBe("down");
    const recovered = applyHealthResult(down, { ok: true }, 1_000);
    expect(recovered.state).toBe("connected");
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.nextAttemptAtMs).toBeUndefined();
  });

  it("keeps `since` pinned to when the state began, not the last check", () => {
    let status = applyHealthResult(initialConnectivity(HOST, 0), { ok: true }, 0);
    const connectedSince = status.since;
    status = applyHealthResult(status, { ok: true }, 5_000);
    expect(status.since).toBe(connectedSince);
    status = applyHealthResult(status, { ok: false }, 6_000, noJitter);
    expect(status.since).not.toBe(connectedSince);
  });

  it("records the health check's outcome, which exercises the real command path", () => {
    const status = applyHealthResult(
      initialConnectivity(HOST, 0),
      { ok: false, outcome: "missing-path", error: "no such directory" },
      0,
      noJitter,
    );
    // A TCP ping would call this host healthy; the real command path does not.
    expect(status.lastProbeOutcome).toBe("missing-path");
    expect(status.lastError).toBe("no such directory");
  });

  it("clears the last error on recovery so stale text is not shown as current", () => {
    const failed = fail();
    expect(failed.lastError).toBe("boom");
    expect(applyHealthResult(failed, { ok: true }, 100).lastError).toBeUndefined();
  });
});

describe("backoff", () => {
  it("grows exponentially and stops at the ceiling", () => {
    const delays = [1, 2, 3, 4, 5, 10, 40].map((failures) => backoffDelayMs(failures, maxJitter));
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index] as number).toBeGreaterThanOrEqual(delays[index - 1] as number);
    }
    expect(delays.at(-1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(0)).toBe(0);
  });

  it("jitters so hosts that lost the same network do not retry in lockstep", () => {
    const low = backoffDelayMs(5, noJitter);
    const high = backoffDelayMs(5, maxJitter);
    expect(low).toBeLessThan(high);
    // A floor keeps the retry from becoming a busy loop.
    expect(low).toBeGreaterThan(0);
  });

  it("holds off attempts until the backoff window elapses", () => {
    const status = applyHealthResult(
      applyHealthResult(initialConnectivity(HOST, 0), { ok: true }, 0),
      { ok: false },
      1_000,
      noJitter,
    );
    const next = status.nextAttemptAtMs as number;
    expect(next).toBeGreaterThan(1_000);
    expect(shouldAttemptNow(status, next - 1)).toBe(false);
    expect(shouldAttemptNow(status, next)).toBe(true);
  });

  it("survives a long outage without overflowing the delay", () => {
    for (const failures of [30, 100, 1_000]) {
      const delay = backoffDelayMs(failures, maxJitter);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(BACKOFF_MAX_MS);
    }
  });
});

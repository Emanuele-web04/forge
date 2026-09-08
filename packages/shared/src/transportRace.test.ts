import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RACE_DEADLINE_MS,
  raceTransports,
  sortByTransportPreference,
  TRANSPORT_PREFERENCE,
  transportPreferenceRank,
  type ScheduleTimeout,
  type TransportCandidate,
  type TransportProbe,
} from "./transportRace";

const loopback: TransportCandidate = { kind: "loopback", url: "http://127.0.0.1:5173" };
const lan: TransportCandidate = { kind: "lan", url: "http://192.168.1.20:5173", label: "mDNS" };
const tailscale: TransportCandidate = { kind: "tailscale", url: "http://mac.tailnet.ts.net:5173" };
const ssh: TransportCandidate = { kind: "ssh", url: "http://127.0.0.1:41234" };
const relay: TransportCandidate = { kind: "relay", url: "wss://relay.synara.dev/client/session" };

/**
 * Flushes the microtask queue to quiescence. A settled probe hops through
 * several `.then` links before the race records it, so the clock must let
 * those run before deciding which timer is next — otherwise it advances past
 * a probe that had, in real time, already answered.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Throws synchronously on one candidate and rejects on the others. */
const throwingProbe: TransportProbe = (candidate) => {
  if (candidate.kind === "loopback") throw new Error("ECONNREFUSED");
  return Promise.reject(new Error("dns"));
};

/**
 * A virtual clock: probes resolve at declared millisecond marks and timers fire
 * at theirs, so preference-vs-latency behavior is exact and the suite never
 * waits on a real timer.
 */
function createClock() {
  interface Task {
    readonly at: number;
    readonly run: () => void;
    cancelled: boolean;
    readonly seq: number;
  }
  const tasks: Task[] = [];
  let now = 0;
  let seq = 0;

  const at = (delay: number, run: () => void): (() => void) => {
    const task: Task = { at: now + Math.max(0, delay), run, cancelled: false, seq: seq++ };
    tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  const schedule: ScheduleTimeout = (callback, ms) => at(ms, callback);

  /** Drains due tasks in time order, settling microtasks between each. */
  const run = async (): Promise<void> => {
    for (;;) {
      await flushMicrotasks();
      const next = tasks
        .filter((task) => !task.cancelled)
        .toSorted((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) return;
      next.cancelled = true;
      now = Math.max(now, next.at);
      next.run();
    }
  };

  return { at, schedule, run, elapsed: () => now };
}

/**
 * Builds a probe from a per-kind script and records what actually ran, which is
 * how "did the race short-circuit" is asserted without inspecting internals.
 */
function scriptedProbe(
  clock: ReturnType<typeof createClock>,
  script: Partial<Record<TransportCandidate["kind"], { after: number; reachable: boolean }>>,
) {
  const started: string[] = [];
  const aborted: string[] = [];
  const probe: TransportProbe = (candidate, signal) => {
    started.push(candidate.kind);
    signal.addEventListener("abort", () => aborted.push(candidate.kind));
    const step = script[candidate.kind];
    if (!step) return new Promise<boolean>(() => {}); // hangs forever
    return new Promise<boolean>((resolve) => {
      clock.at(step.after, () => resolve(step.reachable));
    });
  };
  return { probe, started, aborted };
}

describe("TRANSPORT_PREFERENCE", () => {
  it("is exactly ADR 0007's order", () => {
    expect(TRANSPORT_PREFERENCE).toEqual(["loopback", "lan", "tailscale", "ssh", "relay"]);
  });

  it("ranks loopback best and relay worst", () => {
    expect(transportPreferenceRank("loopback")).toBeLessThan(transportPreferenceRank("relay"));
    expect(transportPreferenceRank("tailscale")).toBeLessThan(transportPreferenceRank("ssh"));
  });

  it("sorts stably, so equal kinds keep the caller's order", () => {
    const lanB: TransportCandidate = { kind: "lan", url: "http://192.168.1.21:5173" };
    expect(sortByTransportPreference([relay, lanB, lan, loopback])).toEqual([
      loopback,
      lanB,
      lan,
      relay,
    ]);
  });

  it("exposes the ADR's ~1.5s / ~3s budgets", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(1_500);
    expect(DEFAULT_RACE_DEADLINE_MS).toBe(3_000);
  });
});

describe("raceTransports preference vs latency", () => {
  it("prefers a slow loopback over a fast relay", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      loopback: { after: 900, reachable: true },
      relay: { after: 10, reachable: true },
    });

    const race = raceTransports([relay, loopback], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.outcome).toBe("reachable");
    expect(result.outcome === "reachable" && result.candidate).toEqual(loopback);
  });

  it("falls to the next preference when the better path refuses", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      loopback: { after: 5, reachable: false },
      lan: { after: 200, reachable: true },
      relay: { after: 1, reachable: true },
    });

    const race = raceTransports([relay, lan, loopback], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.outcome === "reachable" && result.candidate.kind).toBe("lan");
  });

  it("takes the relay when it is the only path that answers", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      loopback: { after: 30, reachable: false },
      relay: { after: 400, reachable: true },
    });

    const race = raceTransports([loopback, relay], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.outcome === "reachable" && result.candidate.kind).toBe("relay");
  });
});

describe("raceTransports short-circuiting", () => {
  it("resolves the moment the top preference answers, without burning the deadline", async () => {
    const clock = createClock();
    // LAN and relay never settle; only the loopback answer can end this race
    // early, and it must, or every couch session pays the full 3s.
    const { probe, aborted } = scriptedProbe(clock, {
      loopback: { after: 50, reachable: true },
    });

    const race = raceTransports([loopback, lan, relay], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.outcome === "reachable" && result.candidate.kind).toBe("loopback");
    expect(clock.elapsed()).toBe(50);
    expect(clock.elapsed()).toBeLessThan(DEFAULT_RACE_DEADLINE_MS);
    // The losers are cancelled rather than left holding sockets.
    expect(aborted).toContain("lan");
    expect(aborted).toContain("relay");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "reachable",
      "cancelled",
      "cancelled",
    ]);
  });

  it("keeps waiting for a better path after a worse one answers", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      relay: { after: 10, reachable: true },
      loopback: { after: 800, reachable: true },
    });

    const race = raceTransports([loopback, relay], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.outcome === "reachable" && result.candidate.kind).toBe("loopback");
    expect(clock.elapsed()).toBe(800);
  });

  it("stops as soon as every probe has settled, well before the deadline", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      loopback: { after: 20, reachable: false },
      relay: { after: 60, reachable: false },
    });

    const race = raceTransports([loopback, relay], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.outcome).toBe("unreachable");
    expect(clock.elapsed()).toBe(60);
  });
});

describe("raceTransports timeouts", () => {
  it("isolates one hanging candidate behind the per-probe timeout", async () => {
    const clock = createClock();
    // Loopback hangs (no script entry). The relay must still win, at the probe
    // timeout rather than the race deadline.
    const { probe, aborted } = scriptedProbe(clock, {
      relay: { after: 100, reachable: true },
    });

    const race = raceTransports([loopback, relay], probe, {
      probeTimeoutMs: 1_500,
      deadlineMs: 3_000,
      schedule: clock.schedule,
    });
    await clock.run();
    const result = await race;

    expect(result.outcome === "reachable" && result.candidate.kind).toBe("relay");
    expect(clock.elapsed()).toBe(1_500);
    expect(aborted).toContain("loopback");
    expect(result.attempts).toEqual([
      { candidate: loopback, status: "timed-out" },
      { candidate: relay, status: "reachable" },
    ]);
  });

  it("reports all-timed-out distinctly from unreachable", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {});

    const race = raceTransports([loopback, relay], probe, {
      probeTimeoutMs: 1_500,
      schedule: clock.schedule,
    });
    await clock.run();
    const result = await race;

    expect(result.outcome).toBe("timed-out");
    expect(result.attempts.every((attempt) => attempt.status === "timed-out")).toBe(true);
  });

  it("calls one refusal enough to make the host unreachable, not timed-out", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      loopback: { after: 5, reachable: false },
    });

    const race = raceTransports([loopback, relay], probe, {
      probeTimeoutMs: 1_500,
      schedule: clock.schedule,
    });
    await clock.run();
    const result = await race;

    expect(result.outcome).toBe("unreachable");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["unreachable", "timed-out"]);
  });

  it("gives up at the overall deadline even when probe timeouts are longer", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {});

    const race = raceTransports([loopback, relay], probe, {
      probeTimeoutMs: 10_000,
      deadlineMs: 3_000,
      schedule: clock.schedule,
    });
    await clock.run();
    const result = await race;

    expect(result.outcome).toBe("timed-out");
    expect(clock.elapsed()).toBe(3_000);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("treats a probe that rejects as unreachable, never as a failed race", async () => {
    const clock = createClock();

    const race = raceTransports([loopback, relay], throwingProbe, { schedule: clock.schedule });
    await clock.run();

    await expect(race).resolves.toMatchObject({ outcome: "unreachable" });
  });
});

describe("raceTransports candidate list", () => {
  it("distinguishes an empty candidate list from an unreachable host", async () => {
    await expect(raceTransports([], () => Promise.resolve(true))).resolves.toEqual({
      outcome: "no-candidates",
      attempts: [],
    });
  });

  it("only considers ssh when the caller includes it (web clients never do)", async () => {
    const clock = createClock();
    const { probe, started } = scriptedProbe(clock, {
      ssh: { after: 10, reachable: true },
      relay: { after: 20, reachable: true },
    });

    const webRace = raceTransports([relay], probe, { schedule: clock.schedule });
    await clock.run();
    expect((await webRace).outcome === "reachable" && started).toEqual(["relay"]);

    const desktopClock = createClock();
    const desktop = scriptedProbe(desktopClock, {
      ssh: { after: 10, reachable: true },
      relay: { after: 1, reachable: true },
    });
    const desktopRace = raceTransports([relay, ssh], desktop.probe, {
      schedule: desktopClock.schedule,
    });
    await desktopClock.run();
    const result = await desktopRace;

    // Present and preferred over the relay, despite answering later.
    expect(result.outcome === "reachable" && result.candidate.kind).toBe("ssh");
    expect(desktop.started.toSorted()).toEqual(["relay", "ssh"]);
  });

  it("probes every candidate concurrently, not one after another", async () => {
    const clock = createClock();
    const { probe, started } = scriptedProbe(clock, {
      loopback: { after: 500, reachable: false },
      lan: { after: 500, reachable: false },
      tailscale: { after: 500, reachable: true },
      relay: { after: 500, reachable: true },
    });

    const race = raceTransports([loopback, lan, tailscale, relay], probe, {
      schedule: clock.schedule,
    });
    await clock.run();
    const result = await race;

    expect(started).toEqual(["loopback", "lan", "tailscale", "relay"]);
    expect(result.outcome === "reachable" && result.candidate.kind).toBe("tailscale");
    // Concurrent: four 500ms probes finish at 500ms, not 2000ms.
    expect(clock.elapsed()).toBe(500);
  });

  it("reports attempts in preference order regardless of input order", async () => {
    const clock = createClock();
    const { probe } = scriptedProbe(clock, {
      loopback: { after: 5, reachable: false },
      lan: { after: 5, reachable: false },
      relay: { after: 5, reachable: false },
    });

    const race = raceTransports([relay, lan, loopback], probe, { schedule: clock.schedule });
    await clock.run();
    const result = await race;

    expect(result.attempts.map((attempt) => attempt.candidate.kind)).toEqual([
      "loopback",
      "lan",
      "relay",
    ]);
  });
});

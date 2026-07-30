import * as FS from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import type { RemoteCommandTarget, RemoteHostConfig } from "@synara/contracts";
import { makeTokenBucketLimiter } from "@synara/shared/rateLimiter";
import { RemoteHostConfigError } from "@synara/shared/remoteCommand";
import {
  PROBE_MARKERS,
  REMOTE_PROBE_DEADLINE_MS,
  REMOTE_PROBE_MAX_AGE_MS,
} from "@synara/shared/remoteHostProbe";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeRemoteHostBroker,
  PROBE_RATE_LIMIT_CAPACITY,
  RemoteHostNotReadyError,
  RemoteHostRateLimitError,
  resolveSshControlDirectory,
  type ProcessRunner,
} from "./remoteHostBroker";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    FS.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(tmpdir(), "synara-broker-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1",
    label: "Workstation",
    destination: "build-box",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 30,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: true, persistSeconds: 300 },
    launcher: { kind: "direct" },
    binaryPath: "/usr/local/bin/agent",
    ...overrides,
  } as RemoteHostConfig;
}

const TARGET: RemoteCommandTarget = {
  cwd: "/home/dev/project",
  args: ["--serve"],
  versionArgs: ["--version"],
};

interface RunnerCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

function scriptedRunner(
  responses: ReadonlyArray<{
    stdout?: string;
    stderr?: string;
    code?: number | null;
    timedOut?: boolean;
  }>,
): { run: ProcessRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  let index = 0;
  const run: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      code: response.code ?? 0,
      timedOut: response.timedOut ?? false,
    };
  };
  return { run, calls };
}

const OK = { stdout: `${PROBE_MARKERS.begin}\nagent 1.0.0\n`, code: 0 };

function makeBroker(
  responses: Parameters<typeof scriptedRunner>[0],
  overrides: { now?: () => number } = {},
) {
  const { run, calls } = scriptedRunner(responses);
  const broker = makeRemoteHostBroker({
    controlDirectory: makeTempDirectory(),
    run,
    now: overrides.now ?? (() => 1_000),
    random: () => 0,
  });
  return { broker, calls };
}

describe("resolveSshControlDirectory", () => {
  it("creates the control directory private to this user", () => {
    const home = makeTempDirectory();
    const directory = resolveSshControlDirectory(home);
    expect(FS.statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing permissive directory instead of using it", () => {
    // A control socket is a live, already-authenticated channel to the host: any
    // local user who can open it rides our credentials without a key.
    const home = makeTempDirectory();
    const directory = Path.join(home, "ssh-control");
    FS.mkdirSync(directory, { recursive: true });
    FS.chmodSync(directory, 0o777);
    resolveSshControlDirectory(home);
    expect(FS.statSync(directory).mode & 0o077).toBe(0);
  });

  it("refuses to share connections when the directory cannot be made private", () => {
    const home = makeTempDirectory();
    const fake = {
      mkdirSync: () => undefined,
      chmodSync: () => undefined,
      lstatSync: () => ({ mode: 0o40777, isSymbolicLink: () => false }) as unknown as FS.Stats,
    };
    expect(() => resolveSshControlDirectory(home, fake as unknown as typeof FS)).toThrow(
      RemoteHostConfigError,
    );
  });

  it("refuses a symlinked control directory, whose target it does not own", () => {
    // A real symlink planted before us, pointing at a directory an attacker owns
    // and has chmod'd 0700. stat() follows the link and reports that innocent
    // 0700, so a mode check alone passes while every live, authenticated control
    // socket is created inside the attacker's directory.
    const home = makeTempDirectory();
    const attackerDirectory = makeTempDirectory();
    FS.chmodSync(attackerDirectory, 0o700);
    FS.symlinkSync(attackerDirectory, Path.join(home, "ssh-control"));

    // The mode check the old code performed would have been satisfied.
    expect(FS.statSync(Path.join(home, "ssh-control")).mode & 0o077).toBe(0);

    expect(() => resolveSshControlDirectory(home)).toThrow(RemoteHostConfigError);
  });
});

describe("probe", () => {
  it("runs the rendered probe command with a bounded deadline", async () => {
    const { broker, calls } = makeBroker([OK]);
    const result = await broker.probe(makeConfig(), TARGET);
    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
    // Our own deadline, not just ssh's ConnectTimeout: a host that answers and
    // then stalls must still fail.
    expect(calls[0]?.timeoutMs).toBe(REMOTE_PROBE_DEADLINE_MS);
    expect(calls[0]?.args).toContain("BatchMode=yes");
  });

  it("multiplexes through our own control socket, not the user's ssh config", async () => {
    const { broker, calls } = makeBroker([OK]);
    await broker.probe(makeConfig(), TARGET);
    const rendered = (calls[0]?.args ?? []).join(" ");
    expect(rendered).toContain("ControlMaster=auto");
    expect(rendered).toContain("ControlPersist=300");
  });

  it("retries through a login shell and reports the launcher to switch to", async () => {
    const { broker, calls } = makeBroker([{ stderr: PROBE_MARKERS.binaryMissing, code: 92 }, OK]);
    const result = await broker.probe(makeConfig(), TARGET);
    expect(calls).toHaveLength(2);
    expect((calls[1]?.args ?? []).join(" ")).toContain("-lc");
    expect(result.outcome).toBe("ok");
    expect(result.suggestedLauncher).toEqual({ kind: "login-shell" });
  });

  it("keeps the specific diagnosis when the rescue also fails", async () => {
    const { broker } = makeBroker([
      { stderr: PROBE_MARKERS.binaryMissing, code: 92 },
      { stderr: PROBE_MARKERS.binaryMissing, code: 92 },
    ]);
    const result = await broker.probe(makeConfig(), TARGET);
    expect(result.outcome).toBe("missing-binary");
    expect(result.suggestedLauncher).toBeUndefined();
  });

  it("does not retry when a login shell cannot change the answer", async () => {
    const { broker, calls } = makeBroker([{ stderr: PROBE_MARKERS.cwdMissing, code: 91 }]);
    const result = await broker.probe(makeConfig(), TARGET);
    expect(result.outcome).toBe("missing-path");
    expect(calls).toHaveLength(1);
  });

  it("refuses a config that would hang, before ever dialling the host", async () => {
    const { broker, calls } = makeBroker([OK]);
    await expect(
      broker.probe(
        makeConfig({ launcher: { kind: "custom-wrapper", command: "tmux", args: [] } }),
        TARGET,
      ),
    ).rejects.toThrow(RemoteHostConfigError);
    expect(calls).toHaveLength(0);
  });

  it("refuses ssh args that would disable host-key verification", async () => {
    const { broker, calls } = makeBroker([OK]);
    await expect(
      broker.probe(makeConfig({ sshArgs: ["-o", "StrictHostKeyChecking=no"] }), TARGET),
    ).rejects.toThrow(RemoteHostConfigError);
    expect(calls).toHaveLength(0);
  });

  it("rate-limits client-triggered probes server-side", async () => {
    let now = 0;
    const { run } = scriptedRunner([OK]);
    const broker = makeRemoteHostBroker({
      controlDirectory: makeTempDirectory(),
      run,
      now: () => now,
      probeLimiter: makeTokenBucketLimiter({
        capacity: PROBE_RATE_LIMIT_CAPACITY,
        refillPerSecond: 1 / 6,
        now: () => now,
      }),
    });
    for (let index = 0; index < PROBE_RATE_LIMIT_CAPACITY; index += 1) {
      await broker.probe(makeConfig(), TARGET);
    }
    await expect(broker.probe(makeConfig(), TARGET)).rejects.toBeInstanceOf(
      RemoteHostRateLimitError,
    );
  });

  it("limits per host, so one bad host cannot block another", async () => {
    let now = 0;
    const { run } = scriptedRunner([OK]);
    const broker = makeRemoteHostBroker({
      controlDirectory: makeTempDirectory(),
      run,
      now: () => now,
      probeLimiter: makeTokenBucketLimiter({ capacity: 1, refillPerSecond: 1 / 6, now: () => now }),
    });
    await broker.probe(makeConfig(), TARGET);
    await expect(broker.probe(makeConfig(), TARGET)).rejects.toBeInstanceOf(
      RemoteHostRateLimitError,
    );
    await expect(
      broker.probe(makeConfig({ hostId: "host-2" } as Partial<RemoteHostConfig>), TARGET),
    ).resolves.toMatchObject({ outcome: "ok" });
  });
});

describe("ensureSessionReady", () => {
  it("re-probes before a session start, not only at creation", async () => {
    let now = 0;
    const { run, calls } = scriptedRunner([OK]);
    const broker = makeRemoteHostBroker({
      controlDirectory: makeTempDirectory(),
      run,
      now: () => now,
    });
    await broker.ensureSessionReady(makeConfig(), TARGET);
    expect(calls).toHaveLength(1);
    // Prior art probed once at creation and never again; a host that broke after
    // setup still displayed "ready" until a turn hung.
    now += REMOTE_PROBE_MAX_AGE_MS + 1;
    await broker.ensureSessionReady(makeConfig(), TARGET);
    expect(calls).toHaveLength(2);
  });

  it("reuses a fresh result for the identical command", async () => {
    const { broker, calls } = makeBroker([OK]);
    await broker.ensureSessionReady(makeConfig(), TARGET);
    await broker.ensureSessionReady(makeConfig(), TARGET);
    expect(calls).toHaveLength(1);
  });

  it("discards a ready result when any input that shapes the command changes", async () => {
    const { broker, calls } = makeBroker([OK]);
    await broker.ensureSessionReady(makeConfig(), TARGET);
    await broker.ensureSessionReady(makeConfig({ destination: "other-box" }), TARGET);
    expect(calls).toHaveLength(2);
    await broker.ensureSessionReady(makeConfig(), { ...TARGET, cwd: "/elsewhere" });
    expect(calls).toHaveLength(3);
  });

  it("refuses to start a session on a host that is not ready", async () => {
    const { broker } = makeBroker([{ stderr: PROBE_MARKERS.cwdMissing, code: 91 }]);
    await expect(broker.ensureSessionReady(makeConfig(), TARGET)).rejects.toBeInstanceOf(
      RemoteHostNotReadyError,
    );
  });

  it("is not blocked by the client-facing rate limit", async () => {
    // The pre-start check is ours, not the client's; throttling it would turn a
    // burst of session starts into failures.
    let now = 0;
    const { run } = scriptedRunner([OK]);
    const broker = makeRemoteHostBroker({
      controlDirectory: makeTempDirectory(),
      run,
      now: () => now,
      probeLimiter: makeTokenBucketLimiter({ capacity: 0, refillPerSecond: 0, now: () => now }),
    });
    await expect(broker.ensureSessionReady(makeConfig(), TARGET)).resolves.toMatchObject({
      outcome: "ok",
    });
  });
});

describe("connectivity", () => {
  it("moves to connected on a successful probe and down after repeated failures", async () => {
    const { broker } = makeBroker([OK]);
    await broker.probe(makeConfig(), TARGET);
    expect(broker.connectivity("host-1" as RemoteHostConfig["hostId"]).state).toBe("connected");

    const failing = makeBroker([{ stderr: "ssh: connect to host: Connection refused", code: 255 }]);
    for (let index = 0; index < 4; index += 1) {
      await failing.broker.probe(makeConfig(), TARGET, { internal: true });
    }
    const status = failing.broker.connectivity("host-1" as RemoteHostConfig["hostId"]);
    expect(status.state).toBe("down");
    expect(status.lastProbeOutcome).toBe("unreachable");
    expect(failing.broker.isUsable("host-1" as RemoteHostConfig["hostId"])).toBe(false);
  });

  it("treats a reachable host with a broken command path as unhealthy", async () => {
    // A bare TCP liveness ping would call this host green.
    const { broker } = makeBroker([{ stderr: PROBE_MARKERS.cwdMissing, code: 91 }]);
    await broker.probe(makeConfig(), TARGET, { internal: true });
    expect(broker.connectivity("host-1" as RemoteHostConfig["hostId"]).lastProbeOutcome).toBe(
      "missing-path",
    );
  });

  it("respects the backoff window before the next health check", async () => {
    let now = 0;
    const { run, calls } = scriptedRunner([{ stderr: "Connection refused", code: 255 }]);
    const broker = makeRemoteHostBroker({
      controlDirectory: makeTempDirectory(),
      run,
      now: () => now,
      random: () => 1,
    });
    await broker.healthCheck(makeConfig(), TARGET);
    expect(calls).toHaveLength(1);
    const next = broker.connectivity("host-1" as RemoteHostConfig["hostId"]).nextAttemptAtMs ?? 0;
    now = next - 1;
    await broker.healthCheck(makeConfig(), TARGET);
    expect(calls).toHaveLength(1);
    now = next;
    await broker.healthCheck(makeConfig(), TARGET);
    expect(calls).toHaveLength(2);
  });
});

describe("sessionInvocation", () => {
  it("is the only supported way to build a session command, and it validates", () => {
    const broker = makeRemoteHostBroker({ controlDirectory: makeTempDirectory() });
    const invocation = broker.sessionInvocation(makeConfig(), TARGET);
    expect(invocation.command).toBe("ssh");
    expect(invocation.args).toContain("BatchMode=yes");
    expect(invocation.args.join(" ")).toContain("ControlMaster=auto");
    expect(() =>
      broker.sessionInvocation(
        makeConfig({ sshArgs: ["-o", "UserKnownHostsFile=/dev/null"] }),
        TARGET,
      ),
    ).toThrow(RemoteHostConfigError);
  });
});

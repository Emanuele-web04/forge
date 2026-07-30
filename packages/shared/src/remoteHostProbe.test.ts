import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import type { RemoteCommandTarget, RemoteHostConfig } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildLauncherArgv, buildRemoteScript } from "./remoteCommand";
import {
  classifyRemoteProbe,
  isProbeResultFresh,
  PROBE_MARKERS,
  REMOTE_PROBE_CONNECT_TIMEOUT_SECONDS,
  REMOTE_PROBE_MAX_AGE_MS,
  remoteProbeSignature,
  renderRemoteProbeCommand,
  renderRemoteSessionCommand,
  shouldRetryThroughLoginShell,
  type RemoteProbeExecution,
} from "./remoteHostProbe";

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

function execution(overrides: Partial<RemoteProbeExecution> = {}): RemoteProbeExecution {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...overrides };
}

function classify(overrides: Partial<RemoteProbeExecution> = {}) {
  return classifyRemoteProbe({
    execution: execution(overrides),
    signature: "sig",
    checkedAt: new Date(0).toISOString(),
    target: TARGET,
  });
}

describe("renderRemoteProbeCommand", () => {
  it("runs the exact session command with only the turn arguments substituted", () => {
    const probe = renderRemoteProbeCommand({ config: makeConfig(), target: TARGET });
    const session = renderRemoteSessionCommand({ config: makeConfig(), target: TARGET });
    const probeLine = probe.invocation.args.at(-1) as string;
    const sessionLine = session.invocation.args.at(-1) as string;

    // Same destination, same launcher, same cwd, same binary.
    expect(probe.invocation.command).toBe(session.invocation.command);
    expect(probeLine).toContain("/home/dev/project");
    expect(sessionLine).toContain("/home/dev/project");
    expect(probeLine).toContain("/usr/local/bin/agent");
    expect(sessionLine).toContain("/usr/local/bin/agent");
    // Only the arguments differ: the check cannot pass for a different command.
    expect(probeLine).toContain("--version");
    expect(probeLine).not.toContain("--serve");
    expect(sessionLine).toContain("--serve");
  });

  it("bounds the probe more tightly than a session so a dead host fails fast", () => {
    const probe = renderRemoteProbeCommand({ config: makeConfig(), target: TARGET });
    expect(probe.invocation.args).toContain(
      `ConnectTimeout=${REMOTE_PROBE_CONNECT_TIMEOUT_SECONDS}`,
    );
    expect(probe.invocation.args).toContain("BatchMode=yes");
  });

  it("keys the result to the SESSION command, so an edit discards a stale ready", () => {
    const base = remoteProbeSignature({ config: makeConfig(), target: TARGET });
    const mutations: ReadonlyArray<() => string> = [
      () => remoteProbeSignature({ config: makeConfig({ destination: "other" }), target: TARGET }),
      () =>
        remoteProbeSignature({
          config: makeConfig({ sshArgs: ["-o", "Compression=yes"] }),
          target: TARGET,
        }),
      () =>
        remoteProbeSignature({
          config: makeConfig({ launcher: { kind: "login-shell" } }),
          target: TARGET,
        }),
      () =>
        remoteProbeSignature({
          config: makeConfig({ binaryPath: "/other/agent" }),
          target: TARGET,
        }),
      () =>
        remoteProbeSignature({
          config: makeConfig({ shellInit: { sourceFiles: ["/x.sh"], env: {} } }),
          target: TARGET,
        }),
      () =>
        remoteProbeSignature({
          config: makeConfig({ hostKeyVerification: "accept-new" }),
          target: TARGET,
        }),
      () =>
        remoteProbeSignature({ config: makeConfig(), target: { ...TARGET, cwd: "/elsewhere" } }),
      () =>
        remoteProbeSignature({ config: makeConfig(), target: { ...TARGET, args: ["--other"] } }),
    ];
    expect(remoteProbeSignature({ config: makeConfig(), target: TARGET })).toBe(base);
    for (const mutate of mutations) {
      expect(mutate()).not.toBe(base);
    }
  });
});

describe("probe script behaviour against a real shell", () => {
  function runProbeScript(
    cwd: string,
    binary: string,
    versionArgs: readonly string[] = ["--version"],
  ): RemoteProbeExecution {
    const script = buildRemoteScript({
      target: { cwd, binary, args: [], versionArgs: [...versionArgs] },
      probe: PROBE_MARKERS,
    });
    const argv = buildLauncherArgv({ kind: "direct" }, script);
    try {
      const stdout = execFileSync(argv[0] as string, argv.slice(1), { encoding: "utf8" });
      return execution({ stdout });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return execution({
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        exitCode: failure.status ?? null,
      });
    }
  }

  it("classifies a missing directory as missing-path, not missing-binary", () => {
    // Both failures say "no such file or directory"; `cd` runs first. Classifying
    // on the message would tell a user to install software they already have.
    const result = classifyRemoteProbe({
      execution: runProbeScript("/definitely/not/here", "/bin/echo"),
      signature: "sig",
      checkedAt: new Date(0).toISOString(),
      target: { ...TARGET, cwd: "/definitely/not/here" },
    });
    expect(result.outcome).toBe("missing-path");
    expect(result.message).toContain("/definitely/not/here");
  });

  it("classifies a missing binary in an existing directory as missing-binary", () => {
    const result = classifyRemoteProbe({
      execution: runProbeScript(tmpdir(), "/definitely/not/an/agent"),
      signature: "sig",
      checkedAt: new Date(0).toISOString(),
      target: TARGET,
    });
    expect(result.outcome).toBe("missing-binary");
  });

  it("reports ok with the version when the real script succeeds", () => {
    // `echo --version` is echoed verbatim by BSD echo but interpreted as a flag
    // by GNU coreutils, so the probe's version argument here is one no echo
    // implementation can claim: the assertion then holds on every platform.
    const result = classifyRemoteProbe({
      execution: runProbeScript(tmpdir(), "/bin/echo", ["synara-probe-version"]),
      signature: "sig",
      checkedAt: new Date(0).toISOString(),
      target: TARGET,
    });
    expect(result.outcome).toBe("ok");
    expect(result.version).toBe("synara-probe-version");
  });

  it("detects shell startup output as noisy-shell through a real login shell", () => {
    const home = mkdtempSync(Path.join(tmpdir(), "synara-rc-"));
    try {
      const script = buildRemoteScript({
        target: { cwd: tmpdir(), binary: "/bin/echo", args: [], versionArgs: ["--version"] },
        probe: PROBE_MARKERS,
      });
      // Simulate an rc file that prints unconditionally, the single most common
      // cause of a silently corrupted protocol stream.
      const stdout = execFileSync("/bin/sh", ["-c", `echo "Welcome to prod"; ${script}`], {
        encoding: "utf8",
      });
      const result = classifyRemoteProbe({
        execution: execution({ stdout }),
        signature: "sig",
        checkedAt: new Date(0).toISOString(),
        target: TARGET,
      });
      expect(result.outcome).toBe("noisy-shell");
      expect(result.noisyOutput).toContain("Welcome to prod");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("classifyRemoteProbe", () => {
  it("reports a timeout as a bounded failure rather than letting it hang", () => {
    const result = classify({ timedOut: true, exitCode: null });
    expect(result.outcome).toBe("unreachable");
    expect(result.unreachableReason).toBe("timeout");
    expect(result.message).toMatch(/password|passphrase/i);
  });

  it("reports a missing local ssh client distinctly", () => {
    const result = classify({ spawnErrorCode: "ENOENT" });
    expect(result.unreachableReason).toBe("ssh-missing");
  });

  it("distinguishes every unreachable reason from ssh's own vocabulary", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Permission denied (publickey,password).", "auth"],
      ["Received disconnect: Too many authentication failures", "auth"],
      ["Host key verification failed.", "host-key"],
      ["@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "host-key"],
      ["ssh: Could not resolve hostname build-box: Name or service not known", "dns"],
      ["ssh: connect to host build-box port 22: Connection refused", "refused"],
      ["ssh: connect to host build-box port 22: No route to host", "network"],
      ["client_loop: send disconnect: Broken pipe", "network"],
      ["ssh: connect to host build-box port 22: Operation timed out", "timeout"],
      ["Timeout, server build-box not responding.", "timeout"],
    ];
    for (const [stderr, reason] of cases) {
      const result = classify({ stderr, exitCode: 255 });
      expect(result.outcome).toBe("unreachable");
      expect(result.unreachableReason).toBe(reason);
      expect(result.message.length).toBeGreaterThan(20);
    }
  });

  it("never classifies on a bare 'not found' substring", () => {
    // A remote binary's OWN diagnostics routinely contain "not found". Prior art
    // substring-matched it and mislabelled unrelated failures.
    const result = classify({
      stdout: `${PROBE_MARKERS.begin}\nagent 1.2.3\n`,
      stderr: "warning: plugin 'foo' not found, continuing",
      exitCode: 0,
    });
    expect(result.outcome).toBe("ok");
  });

  it("does not call a remote command failure unreachable", () => {
    const result = classify({
      stdout: `${PROBE_MARKERS.begin}\n`,
      stderr: "agent: config error",
      exitCode: 3,
    });
    expect(result.outcome).toBe("command-failed");
  });

  it("never leaks anything but trimmed remote output into the result", () => {
    const result = classify({ stderr: "x".repeat(9_000), exitCode: 255 });
    expect((result.detail ?? "").length).toBeLessThan(2_100);
  });

  it("labels a successful login-shell rescue with the launcher to switch to", () => {
    const result = classifyRemoteProbe({
      execution: execution({ stdout: `${PROBE_MARKERS.begin}\nagent 9\n` }),
      signature: "sig",
      checkedAt: new Date(0).toISOString(),
      target: TARGET,
      launcher: { kind: "login-shell" },
      viaRescue: true,
    });
    expect(result.outcome).toBe("ok");
    expect(result.suggestedLauncher).toEqual({ kind: "login-shell" });
  });
});

describe("shouldRetryThroughLoginShell", () => {
  it("retries only when a login shell could plausibly change the answer", () => {
    const missingBinary = classify({ exitCode: 92 });
    expect(shouldRetryThroughLoginShell(missingBinary, { kind: "direct" })).toBe(true);
    // A login shell cannot conjure a missing directory or reach a dead host, and
    // retrying an already-login-shell launcher just doubles the latency.
    expect(shouldRetryThroughLoginShell(missingBinary, { kind: "login-shell" })).toBe(false);
    expect(shouldRetryThroughLoginShell(classify({ exitCode: 91 }), { kind: "direct" })).toBe(
      false,
    );
    expect(
      shouldRetryThroughLoginShell(classify({ stderr: "Connection refused", exitCode: 255 }), {
        kind: "direct",
      }),
    ).toBe(false);
  });
});

describe("isProbeResultFresh", () => {
  const ok = (signature: string, checkedAtMs: number) =>
    classifyRemoteProbe({
      execution: execution({ stdout: `${PROBE_MARKERS.begin}\nv1\n` }),
      signature,
      checkedAt: new Date(checkedAtMs).toISOString(),
      target: TARGET,
    });

  it("accepts a recent success for the same command", () => {
    expect(isProbeResultFresh(ok("sig", 1_000), "sig", 1_000 + 60_000)).toBe(true);
  });

  it("rejects a result whose command signature no longer matches", () => {
    // This is the invariant that makes editing a field discard a stale "ready".
    expect(isProbeResultFresh(ok("old", 1_000), "new", 1_000)).toBe(false);
  });

  it("rejects a stale success, so a host that broke after setup is re-probed", () => {
    expect(isProbeResultFresh(ok("sig", 0), "sig", REMOTE_PROBE_MAX_AGE_MS + 1)).toBe(false);
  });

  it("rejects a missing result and a non-ok result", () => {
    expect(isProbeResultFresh(undefined, "sig", 0)).toBe(false);
    expect(isProbeResultFresh({ ...ok("sig", 0), outcome: "noisy-shell" }, "sig", 0)).toBe(false);
  });

  it("rejects a timestamp from the future, which is a clock jump not freshness", () => {
    expect(isProbeResultFresh(ok("sig", 10_000), "sig", 1_000)).toBe(false);
  });
});

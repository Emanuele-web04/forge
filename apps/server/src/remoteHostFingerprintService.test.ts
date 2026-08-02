import type { RemoteHostConfig } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  fetchRemoteHostFingerprint,
  type RemoteHostFingerprintRunner,
} from "./remoteHostFingerprintService";

const ED25519_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIB2xUxKC1PfLTBFN0PjXqPQjX3TxCr7O0mJl0hDxWNqK";

function makeHost(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1",
    label: "Devbox",
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

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

function runnerFor(
  responses: ReadonlyArray<{ stdout?: string; stderr?: string; code?: number; timedOut?: boolean }>,
): { run: RemoteHostFingerprintRunner; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const run: RemoteHostFingerprintRunner = async (command, args) => {
    calls.push({ command, args });
    const response = responses[index] ?? {};
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

describe("fetchRemoteHostFingerprint", () => {
  it("resolves with ssh -G, then keyscans the resolved target", async () => {
    const { run, calls } = runnerFor([
      { stdout: "hostname 10.0.0.4\nport 2222\n" },
      { stdout: `10.0.0.4 ssh-ed25519 ${ED25519_KEY}\n` },
    ]);

    const result = await fetchRemoteHostFingerprint(makeHost(), run);

    expect(calls[0]).toEqual({ command: "ssh", args: ["-G", "--", "devbox"] });
    expect(calls[1]?.command).toBe("ssh-keyscan");
    // The alias was resolved before scanning: ssh-keyscan cannot read ~/.ssh/config.
    expect(calls[1]?.args).toContain("10.0.0.4");
    expect(calls[1]?.args).toContain("2222");
    expect(result.hostname).toBe("10.0.0.4");
    expect(result.port).toBe(2222);
    expect(result.fingerprints[0]?.fingerprint).toMatch(/^SHA256:/);
    expect(result.error).toBeUndefined();
  });

  it("returns an error with NO fingerprints when resolution fails", async () => {
    // Every failure must degrade to "we cannot show you one" — never to a trust
    // prompt with nothing to compare. An empty list is what makes the UI's
    // canTrustHostKey refuse.
    const { run } = runnerFor([{ code: 255, stderr: "ssh: Could not resolve hostname devbox" }]);
    const result = await fetchRemoteHostFingerprint(makeHost(), run);
    expect(result.fingerprints).toEqual([]);
    expect(result.error).toContain("Could not resolve hostname");
  });

  it("returns an error with no fingerprints when the scan times out", async () => {
    const { run } = runnerFor([{ stdout: "hostname devbox\n" }, { timedOut: true }]);
    const result = await fetchRemoteHostFingerprint(makeHost(), run);
    expect(result.fingerprints).toEqual([]);
    expect(result.error).toMatch(/deadline/i);
  });

  it("returns an error with no fingerprints when the host offers no readable key", async () => {
    const { run } = runnerFor([
      { stdout: "hostname devbox\n" },
      { stdout: "# devbox:22 SSH-2.0-OpenSSH_9.6\n", stderr: "devbox: no hostkey alg" },
    ]);
    const result = await fetchRemoteHostFingerprint(makeHost(), run);
    expect(result.fingerprints).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("never throws a refused config out to the caller", async () => {
    const { run, calls } = runnerFor([]);
    const result = await fetchRemoteHostFingerprint(
      makeHost({ destination: "-oProxyCommand=touch /tmp/x" }),
      run,
    );
    // Refused before any process ran.
    expect(calls).toHaveLength(0);
    expect(result.fingerprints).toEqual([]);
    expect(result.error).toBeDefined();
  });
});

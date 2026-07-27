// FILE: sshRemoteProbe.test.ts
// Purpose: Verifies that each way a remote host can fail is reported as the one thing the
//          user has to fix, rather than as a generic connection error.
// Layer: Shared runtime utility tests
// Depends on: Vitest and sshRemoteProbe helpers

import type { ProjectRemote } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildRemoteProbeSpawn, classifyRemoteProbe } from "./sshRemoteProbe";

const WORKSPACE_ROOT = "/home/claude/work/Calendaty/calendaty-FE";

const remote = (overrides?: Partial<ProjectRemote>): ProjectRemote => ({
  kind: "ssh",
  host: "claude@10.243.0.10",
  sshArgs: [],
  shellInit: null,
  binaryPath: null,
  launcher: { kind: "direct" },
  ...overrides,
});

const classify = (outcome: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  loginShellRetry?: { exitCode: number | null; stdout: string; stderr: string };
}) =>
  classifyRemoteProbe({
    remote: remote(),
    workspaceRoot: WORKSPACE_ROOT,
    binaryName: "claude",
    exitCode: outcome.exitCode,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    ...(outcome.timedOut === undefined ? {} : { timedOut: outcome.timedOut }),
    ...(outcome.loginShellRetry ? { loginShellRetry: outcome.loginShellRetry } : {}),
  });

describe("buildRemoteProbeSpawn", () => {
  it("probes with the exact command a session will run", () => {
    const spawn = buildRemoteProbeSpawn({
      remote: remote({ sshArgs: ["-p", "2222"], launcher: { kind: "login-shell", shell: null } }),
      workspaceRoot: WORKSPACE_ROOT,
    });

    expect(spawn.command).toBe("ssh");
    expect(spawn.args.slice(0, 3)).toEqual(["-T", "-p", "2222"]);
    expect(spawn.args.at(-2)).toBe("claude@10.243.0.10");
    expect(spawn.args.at(-1)).toContain("exec 'bash' '-l' '-c'");
    expect(spawn.args.at(-1)).toContain(WORKSPACE_ROOT);
    expect(spawn.args.at(-1)).toContain("--version");
  });

  it("probes the host's own binary override when one is set", () => {
    const spawn = buildRemoteProbeSpawn({
      remote: remote({ binaryPath: "/usr/local/bin/claude" }),
      workspaceRoot: WORKSPACE_ROOT,
    });

    expect(spawn.args.at(-1)).toContain("/usr/local/bin/claude");
  });
});

describe("classifyRemoteProbe", () => {
  it("separates an ssh-level failure from anything the host said", () => {
    const result = classify({
      exitCode: 255,
      stderr: "Permission denied (publickey).",
    });

    expect(result.status).toBe("unreachable");
    expect(result.summary).toContain("claude@10.243.0.10");
    expect(result.detail).toBe("Permission denied (publickey).");
  });

  it("reports a timeout as its own failure", () => {
    const result = classify({ exitCode: null, timedOut: true });

    expect(result.status).toBe("unreachable");
    expect(result.summary).toMatch(/did not answer/);
  });

  it("distinguishes a missing workspace root from a missing binary", () => {
    const result = classify({
      exitCode: 1,
      stderr: `bash: line 0: cd: ${WORKSPACE_ROOT}: No such file or directory`,
    });

    expect(result.status).toBe("missing-path");
    expect(result.summary).toContain(WORKSPACE_ROOT);
  });

  it("reports a binary that is nowhere to be found", () => {
    const result = classify({
      exitCode: 127,
      stderr: "sh: 1: claude: not found",
    });

    expect(result.status).toBe("missing-binary");
    expect(result.suggestedLauncher).toBeNull();
  });

  it("switches to a login shell when that is where the binary lives", () => {
    const result = classify({
      exitCode: 127,
      stderr: "sh: 1: claude: not found",
      loginShellRetry: { exitCode: 0, stdout: "2.1.4 (Claude Code)\n", stderr: "" },
    });

    expect(result.status).toBe("ok");
    expect(result.suggestedLauncher).toEqual({ kind: "login-shell", shell: null });
    expect(result.version).toBe("2.1.4 (Claude Code)");
    expect(result.summary).toMatch(/login shell/);
  });

  it("keeps reporting a missing binary when the login shell cannot find it either", () => {
    const result = classify({
      exitCode: 127,
      stderr: "sh: 1: claude: not found",
      loginShellRetry: { exitCode: 127, stdout: "", stderr: "bash: claude: command not found" },
    });

    expect(result.status).toBe("missing-binary");
    expect(result.suggestedLauncher).toBeNull();
  });

  it("flags a shell that prints before the agent, because that corrupts the stream", () => {
    const result = classify({
      exitCode: 0,
      stdout: "Welcome to build-box!\nYou have mail.\n2.1.4 (Claude Code)\n",
    });

    expect(result.status).toBe("noisy-shell");
    expect(result.detail).toBe("Welcome to build-box!\nYou have mail.");
    expect(result.version).toBe("2.1.4 (Claude Code)");
  });

  it("accepts a clean run", () => {
    const result = classify({ exitCode: 0, stdout: "2.1.4 (Claude Code)\n" });

    expect(result.status).toBe("ok");
    expect(result.version).toBe("2.1.4 (Claude Code)");
    expect(result.detail).toBeNull();
    expect(result.summary).toContain(WORKSPACE_ROOT);
  });

  it("does not mistake a stderr warning on a successful run for a failure", () => {
    const result = classify({
      exitCode: 0,
      stdout: "2.1.4 (Claude Code)\n",
      stderr: "Warning: Permanently added '10.243.0.10' to the list of known hosts.",
    });

    expect(result.status).toBe("ok");
  });

  it("falls back to a readable message for an unrecognized non-zero exit", () => {
    const result = classify({ exitCode: 13, stderr: "some other failure" });

    expect(result.status).toBe("unreachable");
    expect(result.summary).toContain("exit 13");
    expect(result.detail).toBe("some other failure");
  });
});

import { describe, expect, it } from "vitest";

import {
  expectRemoteSuccess,
  RemoteCommandError,
  type RemoteConnection,
  type RemoteExecResult,
} from "./remoteConnection";

function connectionReturning(result: Partial<RemoteExecResult>): RemoteConnection {
  return {
    describe: "deploy@host",
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result }),
    uploadFile: () => Promise.resolve(),
  };
}

describe("expectRemoteSuccess", () => {
  it("returns the result on exit 0", async () => {
    const result = await expectRemoteSuccess(connectionReturning({ stdout: "ok" }), ["true"]);
    expect(result.stdout).toBe("ok");
  });

  it("throws on a non-zero exit", async () => {
    await expect(
      expectRemoteSuccess(connectionReturning({ exitCode: 1, stderr: "denied" }), ["false"]),
    ).rejects.toThrow(RemoteCommandError);
  });

  // Mutation guard: a signal kill reports exitCode null. Treating null as
  // success would let an OOM-killed tar look like a completed extraction.
  it("treats a signal kill (exitCode null) as a failure, not a pass", async () => {
    await expect(
      expectRemoteSuccess(connectionReturning({ exitCode: null }), ["tar", "-xzf", "x"]),
    ).rejects.toThrow(/exit signal/);
  });

  it("passes stdin and options through untouched", async () => {
    const seen: Array<unknown> = [];
    const connection: RemoteConnection = {
      describe: "deploy@host",
      exec: (_argv, options) => {
        seen.push(options);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
      uploadFile: () => Promise.resolve(),
    };
    await expectRemoteSuccess(connection, ["cat"], { stdin: "payload", timeoutMs: 5 });
    expect(seen[0]).toEqual({ stdin: "payload", timeoutMs: 5 });
  });
});

describe("RemoteCommandError", () => {
  it("names the host and the failing argv", () => {
    const error = new RemoteCommandError({
      host: "deploy@host",
      argv: ["systemctl", "--user", "start", "synara-x.service"],
      result: { exitCode: 5, stdout: "", stderr: "Unit not found" },
    });
    expect(error.message).toContain("deploy@host");
    expect(error.message).toContain("systemctl --user start synara-x.service");
    expect(error.exitCode).toBe(5);
    expect(error.stderr).toBe("Unit not found");
  });

  // Secrets travel on stdin, never argv, precisely so that this holds.
  it("carries no stdin payload into the message", () => {
    const error = new RemoteCommandError({
      host: "deploy@host",
      argv: ["sh", "-c", 'umask 077; cat > "$1"', "sh", "/opt/synara/state/auth-token"],
      result: { exitCode: 1, stdout: "", stderr: "" },
    });
    expect(error.message).not.toContain("token-value");
    expect(error.message).toContain("/opt/synara/state/auth-token");
  });
});

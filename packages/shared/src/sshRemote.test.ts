// FILE: sshRemote.test.ts
// Purpose: Verifies the ssh invocation Synara builds for projects whose workspace is remote.
// Layer: Shared runtime utility tests
// Depends on: Vitest and sshRemote helpers

import type { ProjectRemote } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildLocalSshProcessEnv,
  buildRemoteShellScript,
  buildSshRemoteSpawn,
  describeProjectRemote,
  isRemoteProject,
  parseSshArgs,
  quotePosixShellArgument,
  resolveProjectRemote,
} from "./sshRemote";

const remote = (overrides?: Partial<ProjectRemote>): ProjectRemote => ({
  kind: "ssh",
  host: "build-box",
  sshArgs: [],
  shellInit: null,
  binaryPath: null,
  ...overrides,
});

describe("resolveProjectRemote", () => {
  it("treats a project without a remote as local", () => {
    expect(resolveProjectRemote({})).toBeNull();
    expect(resolveProjectRemote({ remote: null })).toBeNull();
    expect(isRemoteProject(undefined)).toBe(false);
  });

  it("ignores a remote whose host is blank", () => {
    expect(resolveProjectRemote({ remote: remote({ host: "   " }) })).toBeNull();
  });

  it("resolves a configured remote", () => {
    const project = { remote: remote() };
    expect(resolveProjectRemote(project)).toBe(project.remote);
    expect(isRemoteProject(project)).toBe(true);
  });
});

describe("describeProjectRemote", () => {
  it("renders host and workspace root together", () => {
    expect(describeProjectRemote(remote({ host: "deploy@box" }), "/srv/app")).toBe(
      "deploy@box:/srv/app",
    );
  });

  it("falls back to the host alone", () => {
    expect(describeProjectRemote(remote())).toBe("build-box");
  });
});

describe("quotePosixShellArgument", () => {
  it("neutralizes expansion, whitespace, and command substitution", () => {
    expect(quotePosixShellArgument("$HOME; rm -rf /")).toBe("'$HOME; rm -rf /'");
    expect(quotePosixShellArgument("a b")).toBe("'a b'");
    expect(quotePosixShellArgument("")).toBe("''");
  });

  it("escapes embedded single quotes", () => {
    expect(quotePosixShellArgument("it's")).toBe(`'it'\\''s'`);
  });
});

describe("parseSshArgs", () => {
  it("splits on whitespace", () => {
    expect(parseSshArgs("  -p 2222   -i ~/.ssh/id_ed25519 ")).toEqual([
      "-p",
      "2222",
      "-i",
      "~/.ssh/id_ed25519",
    ]);
  });

  it("keeps quoted option values in one argument", () => {
    expect(parseSshArgs(`-o "ProxyCommand=nc %h %p" -J bastion`)).toEqual([
      "-o",
      "ProxyCommand=nc %h %p",
      "-J",
      "bastion",
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(parseSshArgs("   ")).toEqual([]);
  });

  it("preserves an intentionally empty quoted argument", () => {
    expect(parseSshArgs(`-o ""`)).toEqual(["-o", ""]);
  });
});

describe("buildRemoteShellScript", () => {
  it("chains cd, shell init, and an exec'd invocation", () => {
    expect(
      buildRemoteShellScript({
        command: "claude",
        args: ["--print", "--model", "opus"],
        cwd: "/srv/app",
        shellInit: "source ~/.nvm/nvm.sh",
      }),
    ).toBe(`cd '/srv/app' && source ~/.nvm/nvm.sh && exec 'claude' '--print' '--model' 'opus'`);
  });

  it("omits steps that are not configured", () => {
    expect(buildRemoteShellScript({ command: "claude", args: [] })).toBe(`exec 'claude'`);
  });

  it("quotes a workspace root containing shell metacharacters", () => {
    expect(
      buildRemoteShellScript({ command: "claude", args: [], cwd: "/srv/my app; whoami" }),
    ).toBe(`cd '/srv/my app; whoami' && exec 'claude'`);
  });

  it("forwards environment values through env(1) rather than the local process", () => {
    expect(
      buildRemoteShellScript({
        command: "claude",
        args: [],
        env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
      }),
    ).toBe(`exec env CLAUDE_CODE_ENTRYPOINT='sdk-ts' 'claude'`);
  });
});

describe("buildSshRemoteSpawn", () => {
  it("disables pty allocation and keeps the connection supervised", () => {
    const spawn = buildSshRemoteSpawn({
      remote: remote(),
      command: "claude",
      args: [],
      cwd: "/srv/app",
    });

    expect(spawn.command).toBe("ssh");
    expect(spawn.args).toEqual([
      "-T",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "build-box",
      `cd '/srv/app' && exec 'claude'`,
    ]);
  });

  it("places user ssh args before Synara defaults so they win", () => {
    const spawn = buildSshRemoteSpawn({
      remote: remote({ sshArgs: ["-o", "ServerAliveInterval=5", "-J", "bastion"] }),
      command: "claude",
      args: [],
    });

    expect(spawn.args.slice(0, 6)).toEqual([
      "-T",
      "-o",
      "ServerAliveInterval=5",
      "-J",
      "bastion",
      "-o",
    ]);
  });

  it("reverse-forwards loopback ports on the same port number", () => {
    const spawn = buildSshRemoteSpawn({
      remote: remote(),
      command: "claude",
      args: [],
      reverseLoopbackPorts: [3773],
    });

    expect(spawn.args).toContain("-R");
    expect(spawn.args).toContain("3773:127.0.0.1:3773");
  });

  it("passes the remote script as a single argument", () => {
    const spawn = buildSshRemoteSpawn({
      remote: remote(),
      command: "claude",
      args: ["--session-id", "abc"],
      cwd: "/srv/app",
    });

    expect(spawn.args.at(-1)).toBe(`cd '/srv/app' && exec 'claude' '--session-id' 'abc'`);
    expect(spawn.args.at(-2)).toBe("build-box");
  });
});

describe("buildLocalSshProcessEnv", () => {
  it("keeps only what the ssh client itself needs", () => {
    expect(
      buildLocalSshProcessEnv({
        PATH: "/usr/bin",
        HOME: "/Users/dev",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
        ANTHROPIC_API_KEY: "sk-local",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
  });

  it("omits keys that are absent rather than writing undefined entries", () => {
    expect(Object.keys(buildLocalSshProcessEnv({ PATH: "/usr/bin" }))).toEqual(["PATH"]);
  });
});

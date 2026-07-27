// FILE: sshRemoteLauncher.test.ts
// Purpose: Verifies what a remote agent command runs inside on the host, and that wrappers
//          which would detach it from its stdio are refused with an explanation.
// Layer: Shared runtime utility tests
// Depends on: Vitest and sshRemote helpers

import type { ProjectRemoteLauncher } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProjectScript,
  buildRemoteShellScript,
  buildSshRemoteSpawn,
  describeRejectedRemoteLauncher,
  quotePosixShellArgument,
} from "./sshRemote";

const PROJECT_SCRIPT = buildProjectScript({
  command: "claude",
  args: ["-p"],
  cwd: "/srv/app",
});

const render = (launcher: ProjectRemoteLauncher) =>
  buildRemoteShellScript({ command: "claude", args: ["-p"], cwd: "/srv/app", launcher });

describe("buildRemoteShellScript launchers", () => {
  it("runs the project script directly by default", () => {
    expect(render({ kind: "direct" })).toBe(PROJECT_SCRIPT);
    expect(buildRemoteShellScript({ command: "claude", args: [], cwd: "/srv/app" })).toBe(
      "cd '/srv/app' && exec 'claude'",
    );
  });

  it("hands the script to a login shell so the user's profile is loaded", () => {
    expect(render({ kind: "login-shell", shell: null })).toBe(
      `exec 'bash' '-l' '-c' ${quotePosixShellArgument(PROJECT_SCRIPT)}`,
    );
  });

  it("honours a chosen login shell", () => {
    expect(render({ kind: "login-shell", shell: "/usr/bin/zsh" })).toBe(
      `exec '/usr/bin/zsh' '-l' '-c' ${quotePosixShellArgument(PROJECT_SCRIPT)}`,
    );
  });

  it("keeps stdin open for a container exec", () => {
    expect(
      render({ kind: "container", engine: "docker", target: "web", user: null, shell: null }),
    ).toBe(`exec 'docker' 'exec' '-i' 'web' 'sh' '-c' ${quotePosixShellArgument(PROJECT_SCRIPT)}`);
  });

  it("uses podman's own binary name", () => {
    expect(
      render({ kind: "container", engine: "podman", target: "web", user: null, shell: null }),
    ).toBe(`exec 'podman' 'exec' '-i' 'web' 'sh' '-c' ${quotePosixShellArgument(PROJECT_SCRIPT)}`);
  });

  it("uses compose's non-tty flag and passes the user and shell through", () => {
    expect(
      render({
        kind: "container",
        engine: "docker-compose",
        target: "app",
        user: "node",
        shell: "bash",
      }),
    ).toBe(
      `exec 'docker' 'compose' 'exec' '-T' '-u' 'node' 'app' 'bash' '-c' ${quotePosixShellArgument(PROJECT_SCRIPT)}`,
    );
  });

  it("appends a shell to a custom wrapper so the script stays one argument", () => {
    expect(render({ kind: "command", args: ["mise", "exec", "--"], shell: null })).toBe(
      `exec 'mise' 'exec' '--' 'sh' '-c' ${quotePosixShellArgument(PROJECT_SCRIPT)}`,
    );
  });

  it("wraps one identical project script whatever it runs inside", () => {
    const launchers: ReadonlyArray<ProjectRemoteLauncher> = [
      { kind: "login-shell", shell: null },
      { kind: "container", engine: "podman", target: "web", user: null, shell: null },
      { kind: "command", args: ["nix", "develop", "-c"], shell: null },
    ];

    for (const launcher of launchers) {
      expect(render(launcher).endsWith(quotePosixShellArgument(PROJECT_SCRIPT))).toBe(true);
    }
  });

  it("keeps shell setup and environment inside the launcher's shell", () => {
    const rendered = buildRemoteShellScript({
      command: "claude",
      args: [],
      cwd: "/srv/app",
      shellInit: "source ~/.nvm/nvm.sh",
      env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
      launcher: { kind: "container", engine: "docker", target: "web", user: null, shell: null },
    });

    expect(rendered).toContain("nvm.sh");
    expect(rendered).toContain("CLAUDE_CODE_ENTRYPOINT");
    expect(rendered.startsWith("exec 'docker' 'exec' '-i' 'web' 'sh' '-c'")).toBe(true);
  });

  it("carries the project's own launcher into the ssh invocation", () => {
    const spawn = buildSshRemoteSpawn({
      remote: {
        kind: "ssh",
        host: "build-box",
        sshArgs: [],
        shellInit: null,
        binaryPath: null,
        launcher: { kind: "login-shell", shell: null },
      },
      command: "claude",
      args: [],
      cwd: "/srv/app",
    });

    expect(spawn.args.at(-1)?.startsWith("exec 'bash' '-l' '-c'")).toBe(true);
  });
});

describe("describeRejectedRemoteLauncher", () => {
  it("accepts every launcher that runs the agent in place", () => {
    const accepted: ReadonlyArray<ProjectRemoteLauncher> = [
      { kind: "direct" },
      { kind: "login-shell", shell: null },
      { kind: "container", engine: "docker", target: "web", user: null, shell: null },
      { kind: "command", args: ["mise", "exec", "--"], shell: null },
      { kind: "command", args: ["nix", "develop", "-c"], shell: null },
      { kind: "command", args: ["direnv", "exec", "/srv/app"], shell: null },
    ];

    for (const launcher of accepted) {
      expect(describeRejectedRemoteLauncher(launcher)).toBeNull();
    }
  });

  it("refuses terminal multiplexers however they are spelled", () => {
    for (const command of ["tmux", "/usr/bin/tmux", "TMUX", "screen", "zellij", "byobu"]) {
      expect(
        describeRejectedRemoteLauncher({ kind: "command", args: [command, "new"], shell: null }),
      ).toMatch(/never reaches Synara/);
    }
  });

  it("refuses backgrounding wrappers", () => {
    for (const command of ["nohup", "setsid", "daemonize"]) {
      expect(
        describeRejectedRemoteLauncher({ kind: "command", args: [command], shell: null }),
      ).toMatch(/never reaches Synara/);
    }
  });

  it("refuses a detach flag on an otherwise valid wrapper", () => {
    expect(
      describeRejectedRemoteLauncher({
        kind: "command",
        args: ["docker", "exec", "-d", "web"],
        shell: null,
      }),
    ).toMatch(/detaches the agent/);
  });

  it("asks for a command when none was typed", () => {
    expect(describeRejectedRemoteLauncher({ kind: "command", args: [], shell: null })).toMatch(
      /Type the command/,
    );
  });
});

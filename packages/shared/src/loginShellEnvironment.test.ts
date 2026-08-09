import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// `OS.homedir()` throws on hosts with neither HOME nor a passwd entry, and an ESM namespace
// export cannot be spied on — so the failure is injected through the module itself, off by
// default so every other test keeps the real implementation.
const { homeDirectoryFailure } = vi.hoisted(() => ({ homeDirectoryFailure: { active: false } }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: actual,
    homedir: () => {
      if (homeDirectoryFailure.active) throw new Error("no home directory");
      return actual.homedir();
    },
  };
});

import {
  createCachedLoginShellEnvironmentReader,
  createCachedLoginShellPathReader,
  LOGIN_SHELL_ENVIRONMENT_NAMES,
  loginShellEnvironmentCachePath,
} from "./loginShellEnvironment";

const temporaryRoots: Array<string> = [];

function makeTemporaryRoot(): string {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-login-shell-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) FS.rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly homeDirectory: string;
  readonly cachePath: string;
  readonly shell: string;
  readonly zshrcPath: string;
}

function makeFixture(): Fixture {
  const root = makeTemporaryRoot();
  const homeDirectory = Path.join(root, "home");
  FS.mkdirSync(homeDirectory, { recursive: true });
  const zshrcPath = Path.join(homeDirectory, ".zshrc");
  FS.writeFileSync(zshrcPath, "export PATH=/opt/homebrew/bin:$PATH\n");
  // A real file so the interpreter fingerprint is stable across calls.
  const shell = Path.join(root, "zsh");
  FS.writeFileSync(shell, "#!/bin/sh\n");
  return {
    homeDirectory,
    cachePath: Path.join(root, "cache", "login-shell-environment.json"),
    shell,
    zshrcPath,
  };
}

function probeReturning(environment: Partial<Record<string, string>>) {
  return vi.fn(() => environment);
}

describe("createCachedLoginShellEnvironmentReader", () => {
  it("probes once and serves later reads from the cache file", () => {
    const fixture = makeFixture();
    const probe = probeReturning({ PATH: "/opt/homebrew/bin:/usr/bin" });
    const options = {
      platform: "darwin" as const,
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    };

    const first = createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"]);
    expect(first).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(FS.existsSync(fixture.cachePath)).toBe(true);

    // A fresh reader, as a later process would build.
    const second = createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"]);
    expect(second).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("always captures the canonical name set so a PATH-only caller warms the desktop cache", () => {
    const fixture = makeFixture();
    const sshAuthSocket = Path.join(Path.dirname(fixture.shell), "agent.sock");
    FS.writeFileSync(sshAuthSocket, "");
    const probe = probeReturning({
      PATH: "/opt/homebrew/bin",
      SSH_AUTH_SOCK: sshAuthSocket,
    });

    createCachedLoginShellPathReader({
      env: {},
      platform: "darwin",
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    })(fixture.shell);

    expect(probe).toHaveBeenCalledWith(fixture.shell, LOGIN_SHELL_ENVIRONMENT_NAMES, undefined);

    const laterProbe = probeReturning({});
    const environment = createCachedLoginShellEnvironmentReader({
      env: {},
      platform: "darwin",
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe: laterProbe,
    })(fixture.shell, ["PATH", "SSH_AUTH_SOCK"]);

    expect(environment).toEqual({ PATH: "/opt/homebrew/bin", SSH_AUTH_SOCK: sshAuthSocket });
    expect(laterProbe).not.toHaveBeenCalled();
  });

  it("re-probes when a cached SSH agent socket has disappeared", () => {
    const fixture = makeFixture();
    const sshAuthSocket = Path.join(Path.dirname(fixture.shell), "agent.sock");
    FS.writeFileSync(sshAuthSocket, "");
    const probe = vi
      .fn()
      .mockReturnValueOnce({ PATH: "/usr/bin", SSH_AUTH_SOCK: sshAuthSocket })
      .mockReturnValueOnce({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/fresh-agent.sock" });
    const options = {
      env: {},
      platform: "darwin" as const,
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    };

    createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH", "SSH_AUTH_SOCK"]);
    FS.unlinkSync(sshAuthSocket);

    expect(
      createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH", "SSH_AUTH_SOCK"]),
    ).toEqual({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/fresh-agent.sock" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("prefers the current process SSH agent socket over a cached session", () => {
    const fixture = makeFixture();
    const cachedSocket = Path.join(Path.dirname(fixture.shell), "cached-agent.sock");
    FS.writeFileSync(cachedSocket, "");
    const probe = probeReturning({ PATH: "/usr/bin", SSH_AUTH_SOCK: cachedSocket });
    const baseOptions = {
      env: {},
      platform: "darwin" as const,
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    };

    createCachedLoginShellEnvironmentReader(baseOptions)(fixture.shell, ["PATH", "SSH_AUTH_SOCK"]);

    expect(
      createCachedLoginShellEnvironmentReader({
        ...baseOptions,
        env: { SSH_AUTH_SOCK: "/current-agent.sock" },
      })(fixture.shell, ["PATH", "SSH_AUTH_SOCK"]),
    ).toEqual({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/current-agent.sock" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes when a tracked startup file changes", () => {
    const fixture = makeFixture();
    const probe = vi
      .fn()
      .mockReturnValueOnce({ PATH: "/first" })
      .mockReturnValueOnce({ PATH: "/second" });
    const options = {
      platform: "darwin" as const,
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    };

    expect(createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"])).toEqual({
      PATH: "/first",
    });

    FS.writeFileSync(fixture.zshrcPath, "export PATH=/opt/homebrew/bin:/extra:$PATH\n");
    FS.utimesSync(fixture.zshrcPath, new Date(), new Date(Date.now() + 60_000));

    expect(createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"])).toEqual({
      PATH: "/second",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("re-probes when a tracked startup file appears", () => {
    const fixture = makeFixture();
    const probe = vi
      .fn()
      .mockReturnValueOnce({ PATH: "/first" })
      .mockReturnValueOnce({ PATH: "/second" });
    const options = {
      platform: "darwin" as const,
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    };

    createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"]);
    FS.writeFileSync(Path.join(fixture.homeDirectory, ".zprofile"), "\n");

    expect(createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"])).toEqual({
      PATH: "/second",
    });
  });

  it("re-probes once the entry ages past its ceiling", () => {
    const fixture = makeFixture();
    const probe = vi
      .fn()
      .mockReturnValueOnce({ PATH: "/first" })
      .mockReturnValueOnce({ PATH: "/second" });

    createCachedLoginShellEnvironmentReader({
      platform: "darwin",
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
      now: () => 0,
    })(fixture.shell, ["PATH"]);

    expect(
      createCachedLoginShellEnvironmentReader({
        platform: "darwin",
        homeDirectory: fixture.homeDirectory,
        cachePath: fixture.cachePath,
        probe,
        now: () => 8 * 24 * 60 * 60 * 1_000,
      })(fixture.shell, ["PATH"]),
    ).toEqual({ PATH: "/second" });
  });

  it("falls back to probing when the cache file is corrupt", () => {
    const fixture = makeFixture();
    FS.mkdirSync(Path.dirname(fixture.cachePath), { recursive: true });
    FS.writeFileSync(fixture.cachePath, "{ not json");
    const probe = probeReturning({ PATH: "/opt/homebrew/bin" });

    expect(
      createCachedLoginShellEnvironmentReader({
        platform: "darwin",
        homeDirectory: fixture.homeDirectory,
        cachePath: fixture.cachePath,
        probe,
      })(fixture.shell, ["PATH"]),
    ).toEqual({ PATH: "/opt/homebrew/bin" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  // A probe that answered with nothing is a failure to retry, not a result to remember.
  it("does not cache a probe that produced no PATH", () => {
    const fixture = makeFixture();
    const probe = probeReturning({});

    createCachedLoginShellEnvironmentReader({
      platform: "darwin",
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    })(fixture.shell, ["PATH"]);

    expect(FS.existsSync(fixture.cachePath)).toBe(false);
  });

  it("propagates probe failures so the caller can try the next shell", () => {
    const fixture = makeFixture();
    const probe = vi.fn(() => {
      throw new Error("unknown flag");
    });

    expect(() =>
      createCachedLoginShellEnvironmentReader({
        platform: "darwin",
        homeDirectory: fixture.homeDirectory,
        cachePath: fixture.cachePath,
        probe,
      })(fixture.shell, ["PATH"]),
    ).toThrow("unknown flag");
  });

  it("keeps entries for different shells apart", () => {
    const fixture = makeFixture();
    const otherShell = Path.join(Path.dirname(fixture.shell), "bash");
    FS.writeFileSync(otherShell, "#!/bin/sh\n");
    const probe = vi
      .fn()
      .mockReturnValueOnce({ PATH: "/from-zsh" })
      .mockReturnValueOnce({ PATH: "/from-bash" });
    const options = {
      platform: "darwin" as const,
      homeDirectory: fixture.homeDirectory,
      cachePath: fixture.cachePath,
      probe,
    };

    expect(createCachedLoginShellEnvironmentReader(options)(fixture.shell, ["PATH"])).toEqual({
      PATH: "/from-zsh",
    });
    expect(createCachedLoginShellEnvironmentReader(options)(otherShell, ["PATH"])).toEqual({
      PATH: "/from-bash",
    });
  });

  // A process with neither HOME nor a passwd entry (containers, sandboxed CI) cannot
  // resolve a home to key the cache against. The desktop builds this reader before
  // `whenReady()` outside any try, so that must degrade to probing, never throw.
  it("runs uncached when the home directory cannot be resolved", () => {
    const fixture = makeFixture();
    // Pointed at the fixture root, so a spy that failed to apply writes here (and fails the
    // call-count assertion below) instead of touching the developer's real Synara home.
    const env = { SYNARA_HOME: Path.dirname(Path.dirname(fixture.cachePath)) };
    homeDirectoryFailure.active = true;

    try {
      const probe = probeReturning({ PATH: "/opt/homebrew/bin" });
      const read = createCachedLoginShellEnvironmentReader({ platform: "darwin", env, probe });

      expect(read(fixture.shell, ["PATH"])).toEqual({ PATH: "/opt/homebrew/bin" });
      expect(read(fixture.shell, ["PATH"])).toEqual({ PATH: "/opt/homebrew/bin" });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      homeDirectoryFailure.active = false;
    }
  });

  it("never persists anything when the cache is disabled", () => {
    const fixture = makeFixture();
    const probe = probeReturning({ PATH: "/opt/homebrew/bin" });
    const read = createCachedLoginShellEnvironmentReader({
      platform: "darwin",
      homeDirectory: fixture.homeDirectory,
      cachePath: null,
      probe,
    });

    read(fixture.shell, ["PATH"]);
    read(fixture.shell, ["PATH"]);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(FS.existsSync(Path.dirname(fixture.cachePath))).toBe(false);
  });
});

describe("loginShellEnvironmentCachePath", () => {
  it("anchors the cache in the Synara home both processes resolve", () => {
    expect(loginShellEnvironmentCachePath({ env: { SYNARA_HOME: "/tmp/synara-home" } })).toBe(
      Path.resolve("/tmp/synara-home", "cache", "login-shell-environment.json"),
    );
    expect(loginShellEnvironmentCachePath({ env: {}, homeDirectory: "/users/test" })).toBe(
      Path.join("/users/test", ".synara", "cache", "login-shell-environment.json"),
    );
  });
});

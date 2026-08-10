import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAccountProtocolVersionError,
  openCodexAccountProtocolClient,
} from "./codexAccountProtocolClient";
import {
  MANAGED_CODEX_PROFILE_ROOT_MARKER,
  materializeCodexManagedProfileHome,
} from "./codexManagedProfileHome";
import {
  makeLegacyCodexLaunchContext,
  makeManagedCodexLaunchContext,
} from "./codexProviderLaunchContext";

type JsonObject = Record<string, unknown>;

let nextPid = 80_000;
const temporaryRoots: string[] = [];
const MISSING_USER_AGENT = Symbol("missing user agent");

class FakeCodexAccountChild extends EventEmitter {
  readonly pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: JsonObject[] = [];
  private inputBuffer = "";

  constructor(
    private readonly handleRequest: (
      request: JsonObject,
      child: FakeCodexAccountChild,
    ) => void,
    spawned = true,
  ) {
    super();
    this.pid = spawned ? nextPid++ : undefined;
    this.stdin.on("data", (chunk: Buffer) => {
      this.inputBuffer += chunk.toString("utf8");
      let newlineIndex = this.inputBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.inputBuffer.slice(0, newlineIndex);
        this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const message = JSON.parse(line) as JsonObject;
          this.received.push(message);
          if ("id" in message) this.handleRequest(message, this);
        }
        newlineIndex = this.inputBuffer.indexOf("\n");
      }
    });
  }

  send(message: JsonObject): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  markExited(): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function makeTemporaryDirectory(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `synara-account-protocol-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function makeLaunchContext(sourceHomePath: string, binaryPath = "/usr/bin/codex") {
  return makeLegacyCodexLaunchContext({
    target: { provider: "codex", profileId: "default" },
    binaryPath,
    settingsRevision: 1,
    registryRevision: 0,
    sourceHomePath,
  });
}

function makeTeardown(child: FakeCodexAccountChild) {
  return vi.fn(
    async (input: { readonly rootPid: number; readonly rootExited: Promise<unknown> }) => {
      expect(input.rootPid).toBe(child.pid);
      child.markExited();
      await input.rootExited;
      return { escalated: false as const, signalErrors: [] };
    },
  );
}

function makeInitializedChild(
  reportedCodexHome: string,
  userAgent: unknown | typeof MISSING_USER_AGENT = "synara_desktop/0.144.1 (test)",
): FakeCodexAccountChild {
  return new FakeCodexAccountChild((request, child) => {
    const id = request.id;
    if (request.method === "initialize") {
      const result: JsonObject = { codexHome: reportedCodexHome };
      if (userAgent !== MISSING_USER_AGENT) result.userAgent = userAgent;
      queueMicrotask(() => child.send({ id, result }));
      return;
    }
    if (request.method === "account/logout") {
      queueMicrotask(() => child.send({ id, result: {} }));
    }
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Codex account protocol client", () => {
  it.runIf(process.platform !== "win32")(
    "accepts a realpath-equivalent Codex home",
    async () => {
      const root = makeTemporaryDirectory("realpath");
      const actualHome = path.join(root, "actual-home");
      const aliasedHome = path.join(root, "aliased-home");
      fs.mkdirSync(actualHome);
      fs.symlinkSync(actualHome, aliasedHome, "dir");

      const child = makeInitializedChild(actualHome);
      const teardownProcessTree = makeTeardown(child);
      const client = await openCodexAccountProtocolClient({
        launchContext: makeLaunchContext(aliasedHome),
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH },
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
        teardownProcessTree,
      });

      await client.close();
      expect(teardownProcessTree).toHaveBeenCalledOnce();
    },
  );

  it("tolerates unrelated notifications and omits params from account/logout", async () => {
    const root = makeTemporaryDirectory("logout");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home);
    const teardownProcessTree = makeTeardown(child);
    const client = await openCodexAccountProtocolClient({
      launchContext: makeLaunchContext(home),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      teardownProcessTree,
    });

    const notifications: JsonObject[] = [];
    client.onNotification((notification) => notifications.push(notification));
    child.send({ method: "account/rateLimits/updated", params: { ignored: true } });
    await expect(client.request("account/logout")).resolves.toEqual({});

    expect(notifications).toEqual([
      { method: "account/rateLimits/updated", params: { ignored: true } },
    ]);
    expect(child.received.find((message) => message.method === "account/logout")).toEqual({
      method: "account/logout",
      id: 2,
    });

    await client.close();
    expect(teardownProcessTree).toHaveBeenCalledOnce();
  });

  it("anchors a relative legacy Codex home to the account-process cwd", async () => {
    const root = makeTemporaryDirectory("relative-home");
    const home = path.join(root, "relative-codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home);
    const teardownProcessTree = makeTeardown(child);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);

    const client = await openCodexAccountProtocolClient({
      launchContext: makeLaunchContext("relative-codex-home"),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess,
      teardownProcessTree,
    });

    expect(spawnProcess.mock.calls[0]?.[0]?.env.CODEX_HOME).toBe(home);
    await client.close();
    expect(teardownProcessTree).toHaveBeenCalledOnce();
  });

  it("runs managed account control from the private profile root", async () => {
    const root = makeTemporaryDirectory("managed-cwd");
    const ambientCwd = root;
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codex", "config.toml"),
      'model_provider = "hostile"\n',
    );
    const storageKey = "11111111-1111-4111-8111-111111111111";
    const { codexHomePath: home, codexSqliteHomePath: sqlite } =
      materializeCodexManagedProfileHome({
        profilesRoot: path.join(root, "private-profiles"),
        storageKey,
      });
    const profileRoot = path.dirname(home);
    const launchContext = makeManagedCodexLaunchContext({
      target: { provider: "codex", profileId: "codex_managed" },
      binaryPath: "/usr/bin/codex",
      settingsRevision: 1,
      registryRevision: 1,
      authenticationBoundAt: null,
      continuationNamespaceId: storageKey,
      codexHomePath: home,
      codexSqliteHomePath: sqlite,
    });
    const child = makeInitializedChild(home);
    const teardownProcessTree = makeTeardown(child);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);

    const client = await openCodexAccountProtocolClient({
      launchContext,
      cwd: ambientCwd,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess,
      teardownProcessTree,
    });

    expect(spawnProcess.mock.calls[0]?.[0]?.cwd).toBe(profileRoot);
    expect(fs.existsSync(path.join(profileRoot, MANAGED_CODEX_PROFILE_ROOT_MARKER))).toBe(true);
    expect(path.relative(profileRoot, path.join(root, ".codex", "config.toml"))).toMatch(
      /^\.\./u,
    );
    await client.close();
  });

  it("rejects a different initialized Codex home and proves teardown before rejecting", async () => {
    const root = makeTemporaryDirectory("home-mismatch");
    const expectedHome = path.join(root, "expected-home");
    const reportedHome = path.join(root, "reported-home");
    fs.mkdirSync(expectedHome);
    fs.mkdirSync(reportedHome);
    const child = makeInitializedChild(reportedHome);
    const teardownProcessTree = makeTeardown(child);

    await expect(
      openCodexAccountProtocolClient({
        launchContext: makeLaunchContext(expectedHome),
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH },
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
        teardownProcessTree,
      }),
    ).rejects.toThrow("unexpected home directory");

    expect(teardownProcessTree).toHaveBeenCalledOnce();
    expect(child.exitCode).toBe(0);
  });

  it.each([
    {
      label: "invalid stdout framing",
      trigger: (child: FakeCodexAccountChild) => {
        child.stdout.write(Buffer.from([0xff, 0x0a]));
      },
    },
    {
      label: "stdout closing",
      trigger: (child: FakeCodexAccountChild) => {
        child.stdout.end();
      },
    },
    {
      label: "a child-process error",
      trigger: (child: FakeCodexAccountChild) => {
        child.emit("error", new Error("child process failed"));
      },
    },
    {
      label: "a stdin stream error",
      trigger: (child: FakeCodexAccountChild) => {
        child.stdin.emit("error", new Error("stdin failed"));
      },
    },
    {
      label: "a stdout stream error",
      trigger: (child: FakeCodexAccountChild) => {
        child.stdout.emit("error", new Error("stdout failed"));
      },
    },
    {
      label: "a stderr stream error",
      trigger: (child: FakeCodexAccountChild) => {
        child.stderr.emit("error", new Error("stderr failed"));
      },
    },
  ])("self-tears down after $label and replays the terminal failure to late listeners", async ({
    trigger,
  }) => {
    const root = makeTemporaryDirectory("terminal-failure");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home);
    const teardownProcessTree = makeTeardown(child);
    const client = await openCodexAccountProtocolClient({
      launchContext: makeLaunchContext(home),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      teardownProcessTree,
    });
    const firstListener = vi.fn();
    client.onUnexpectedClose(firstListener);

    trigger(child);

    await vi.waitFor(() => {
      expect(teardownProcessTree).toHaveBeenCalledOnce();
      expect(firstListener).toHaveBeenCalledOnce();
    });
    const terminalError = firstListener.mock.calls[0]?.[0];
    expect(terminalError).toBeInstanceOf(Error);

    const lateListener = vi.fn();
    client.onUnexpectedClose(lateListener);
    await vi.waitFor(() => expect(lateListener).toHaveBeenCalledOnce());
    expect(lateListener).toHaveBeenCalledWith(terminalError);

    await client.close();
    expect(teardownProcessTree).toHaveBeenCalledOnce();
  });

  it("self-tears down when a request cannot be written to stdin", async () => {
    const root = makeTemporaryDirectory("stdin-failure");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home);
    const teardownProcessTree = makeTeardown(child);
    const client = await openCodexAccountProtocolClient({
      launchContext: makeLaunchContext(home),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      teardownProcessTree,
    });
    child.stdin.end();

    await expect(client.request("account/read", { refreshToken: false })).rejects.toBeInstanceOf(
      Error,
    );
    await vi.waitFor(() => expect(teardownProcessTree).toHaveBeenCalledOnce());
  });

  it("treats a request timeout as a terminal transport failure", async () => {
    const root = makeTemporaryDirectory("request-timeout");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home);
    const teardownProcessTree = makeTeardown(child);
    const client = await openCodexAccountProtocolClient({
      launchContext: makeLaunchContext(home),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      teardownProcessTree,
    });
    const terminalListener = vi.fn();
    client.onUnexpectedClose(terminalListener);

    await expect(
      client.request("account/read", { refreshToken: false }, 1),
    ).rejects.toThrow("Timed out waiting for Codex account operation account/read.");
    await vi.waitFor(() => {
      expect(terminalListener).toHaveBeenCalledOnce();
      expect(teardownProcessTree).toHaveBeenCalledOnce();
    });

    await client.close();
    expect(teardownProcessTree).toHaveBeenCalledOnce();
  });

  it("treats an unspawnable child with no PID as already retired", async () => {
    const root = makeTemporaryDirectory("spawn-failure");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = new FakeCodexAccountChild(() => undefined, false);
    const teardownProcessTree = vi.fn();
    const opening = openCodexAccountProtocolClient({
      launchContext: makeLaunchContext(home),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      teardownProcessTree,
    });
    queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));

    await expect(opening).rejects.toThrow("spawn ENOENT");
    expect(teardownProcessTree).not.toHaveBeenCalled();
  });

  it("never recaptures a stale PID after teardown fails following root exit", async () => {
    const root = makeTemporaryDirectory("sticky-teardown");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home);
    const teardownFailure = new Error("descendant exit proof unavailable");
    const teardownProcessTree = vi.fn(
      async (input: { readonly rootPid: number; readonly rootExited: Promise<unknown> }) => {
        child.markExited();
        await input.rootExited;
        throw teardownFailure;
      },
    );
    const client = await openCodexAccountProtocolClient({
      launchContext: makeLaunchContext(home),
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      teardownProcessTree,
    });

    await expect(client.close()).rejects.toBe(teardownFailure);
    await expect(client.close()).rejects.toBe(teardownFailure);

    expect(teardownProcessTree).toHaveBeenCalledOnce();
    expect(teardownProcessTree.mock.calls[0]?.[0]?.rootPid).toBe(child.pid);
  });

  it.each([
    {
      label: "a version below the account-control feature floor",
      userAgent: "synara_desktop/0.143.0 (test)",
      installedVersion: "0.143.0",
    },
    {
      label: "an invalid user agent",
      userAgent: "synara_desktop/unknown (test)",
      installedVersion: null,
    },
    {
      label: "a missing user agent",
      userAgent: MISSING_USER_AGENT,
      installedVersion: null,
    },
  ])("rejects $label and proves app-server teardown before rejecting", async ({
    userAgent,
    installedVersion,
  }) => {
    const root = makeTemporaryDirectory("unsupported-version");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    const child = makeInitializedChild(home, userAgent);
    const teardownProcessTree = makeTeardown(child);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);

    await expect(
      openCodexAccountProtocolClient({
        launchContext: makeLaunchContext(home),
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH },
        spawnProcess,
        teardownProcessTree,
      }),
    ).rejects.toMatchObject({
      name: CodexAccountProtocolVersionError.name,
      installedVersion,
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(teardownProcessTree).toHaveBeenCalledOnce();
    expect(child.exitCode).toBe(0);
  });
});

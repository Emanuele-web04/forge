import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import {
  __terminalHistorySanitizeTesting,
  __terminalManagerShellTesting,
  TerminalManagerRuntime,
  type TerminalSubprocessActivity,
} from "./Manager";
import type { ProcessTreeKiller } from "../processTreeKiller";
import type { ProcessChildrenSnapshotObserver } from "../windowsProcessSnapshot";
import { Effect, Encoding } from "effect";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  paused = false;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  constructor(private readonly mode: "sync" | "async" = "sync") {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

describe("TerminalManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers PowerShell for new Windows terminals before cmd.exe fallbacks", () => {
    const candidates = __terminalManagerShellTesting.resolveShellCandidates(
      () => __terminalManagerShellTesting.windowsDefaultTerminalShell,
      {
        envComSpec: "C:\\Windows\\System32\\cmd.exe",
        platform: "win32",
      },
    );

    expect(candidates.map((candidate) => candidate.shell)).toEqual([
      "powershell.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "cmd.exe",
    ]);
  });

  it("keeps explicit Windows shell requests ahead of PowerShell defaults", () => {
    const candidates = __terminalManagerShellTesting.resolveShellCandidates(() => "pwsh.exe", {
      envComSpec: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
    });

    expect(candidates.map((candidate) => candidate.shell)).toEqual([
      "pwsh.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "powershell.exe",
      "cmd.exe",
    ]);
  });

  function makeManager(
    historyLineLimit = 5,
    options: {
      shellResolver?: () => string;
      subprocessChecker?: (terminalPid: number) => Promise<boolean | TerminalSubprocessActivity>;
      processSnapshotObserver?: ProcessChildrenSnapshotObserver;
      processTreeKiller?: ProcessTreeKiller;
      subprocessPollIntervalMs?: number;
      processKillGraceMs?: number;
      maxRetainedInactiveSessions?: number;
      ptyAdapter?: FakePtyAdapter;
      prepareLogs?: (logsDir: string) => void;
    } = {},
  ) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-terminal-"));
    tempDirs.push(logsDir);
    options.prepareLogs?.(logsDir);
    const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
    const manager = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter,
      historyLineLimit,
      shellResolver: options.shellResolver ?? (() => "/bin/bash"),
      ...(options.subprocessChecker ? { subprocessChecker: options.subprocessChecker } : {}),
      ...(options.processSnapshotObserver
        ? { processSnapshotObserver: options.processSnapshotObserver }
        : {}),
      ...(options.processTreeKiller ? { processTreeKiller: options.processTreeKiller } : {}),
      ...(options.subprocessPollIntervalMs
        ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
        : {}),
      ...(options.processKillGraceMs ? { processKillGraceMs: options.processKillGraceMs } : {}),
      ...(options.maxRetainedInactiveSessions
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
    });
    return { logsDir, ptyAdapter, manager };
  }

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter } = makeManager();
    const [first, second] = await Promise.all([
      manager.open(openInput()),
      manager.open(openInput()),
    ]);
    const third = await manager.open(openInput());

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    manager.dispose();
  });

  it("supports asynchronous PTY spawn effects", async () => {
    const { manager, ptyAdapter } = makeManager(5, { ptyAdapter: new FakePtyAdapter("async") });

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.processes).toHaveLength(1);

    manager.dispose();
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.write({ threadId: "thread-1", data: "ls\n" });
    await manager.resize({ threadId: "thread-1", cols: 120, rows: 30 });

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);

    manager.dispose();
  });

  it("resizes running terminal on open when a different size is requested", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.open(openInput({ cols: 140, rows: 40 }));

    expect(process.resizeCalls).toEqual([{ cols: 140, rows: 40 }]);

    manager.dispose();
  });

  it("keeps a running terminal alive when open reattaches with different cwd or env", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    const snapshot = await manager.open(
      openInput({ cwd: logsDir, env: { SYNARA_TERMINAL_TEST: "changed" } }),
    );

    expect(snapshot.cwd).toBe(globalThis.process.cwd());
    expect(snapshot.status).toBe("running");
    expect(process.killSignals).toEqual([]);
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    await manager.write({ threadId: "thread-1", data: "echo alive\n" });
    expect(process.writes).toContain("echo alive\n");

    manager.dispose();
  });

  it("preserves existing terminal size on open when size is omitted", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const ptyProcess = ptyAdapter.processes[0];
    expect(ptyProcess).toBeDefined();
    if (!ptyProcess) return;

    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    expect(ptyProcess.resizeCalls).toEqual([]);

    ptyProcess.emitExit({ exitCode: 0, signal: 0 });
    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    const resumedSpawn = ptyAdapter.spawnInputs[1];
    expect(resumedSpawn).toBeDefined();
    if (!resumedSpawn) return;
    expect(resumedSpawn.cols).toBe(100);
    expect(resumedSpawn.rows).toBe(24);

    manager.dispose();
  });

  it("uses default dimensions when opening a new terminal without size hints", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open({
      threadId: "thread-1",
      cwd: process.cwd(),
    });

    const spawned = ptyAdapter.spawnInputs[0];
    expect(spawned).toBeDefined();
    if (!spawned) return;
    expect(spawned.cols).toBe(120);
    expect(spawned.rows).toBe(30);

    manager.dispose();
  });

  it("supports multiple terminals per thread with isolated sessions", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "term-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
    await manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);

    manager.dispose();
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await manager.clear({ threadId: "thread-1" });
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);

    manager.dispose();
  });

  it.skipIf(process.platform === "win32")(
    "creates terminal history with private permissions",
    async () => {
      const { manager, ptyAdapter, logsDir } = makeManager();
      await manager.open(openInput());
      ptyAdapter.processes[0]?.emitData("private history\n");
      const historyPath = historyLogPath(logsDir);
      await waitFor(() => fs.existsSync(historyPath));

      expect(fs.statSync(logsDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);

      manager.dispose();
    },
  );

  it.skipIf(process.platform === "win32")(
    "repairs existing terminal history permissions on first open",
    async () => {
      const { manager, logsDir } = makeManager(5, {
        prepareLogs: (directoryPath) => {
          fs.chmodSync(directoryPath, 0o755);
          fs.writeFileSync(historyLogPath(directoryPath), "existing history\n", { mode: 0o644 });
        },
      });

      expect(fs.statSync(logsDir).mode & 0o777).toBe(0o700);
      await manager.open(openInput());
      expect(fs.statSync(historyLogPath(logsDir)).mode & 0o777).toBe(0o600);

      manager.dispose();
    },
  );

  it("keeps pty reads paused until renderer output ACKs drain", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.ackOutput({ threadId: "thread-1", terminalId: "default", bytes: 1 });
    const output = "x".repeat(120_000);
    process.emitData(output);

    await waitFor(() => process.paused);
    expect(
      events.some((event) => event.type === "output" && event.byteLength === output.length),
    ).toBe(true);

    await manager.ackOutput({ threadId: "thread-1", terminalId: "default", bytes: 116_000 });

    expect(process.paused).toBe(false);
    manager.dispose();
  });

  it("drains output into history without emitting output events when streamOutput is false", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput({ streamOutput: false }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("dev server listening\n");
    // History is still drained and persisted even though nothing is broadcast.
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await waitFor(() =>
      fs.readFileSync(historyLogPath(logsDir), "utf8").includes("dev server listening"),
    );

    // No live output event ever reaches the WebSocket fanout for a headless session.
    expect(events.some((event) => event.type === "output")).toBe(false);

    // Re-opening with streamOutput:true flips the session back to live mode (e.g. a
    // log viewer attaching later); omitting the flag would preserve headless mode.
    await manager.open(openInput({ streamOutput: true }));
    process.emitData("after attach\n");
    await waitFor(() => events.some((event) => event.type === "output"));

    manager.dispose();
  });

  it("resumes ack-paused reads when a renderer reattaches", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    // Renderer proves ACK support, then a burst pauses reads without draining.
    await manager.ackOutput({ threadId: "thread-1", terminalId: "default", bytes: 1 });
    process.emitData("x".repeat(120_000));
    await waitFor(() => process.paused);

    // Renderer disconnects while paused and reattaches (open on a running session).
    // Without resetting the previous client's ACK accounting the PTY would stay
    // paused forever, since the fresh renderer never ACKs output it never received.
    await manager.open(openInput());

    expect(process.paused).toBe(false);
    manager.dispose();
  });

  it("includes live terminal mode replay preamble in reattach snapshots", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("\u001b[?2004h\u001b[?1002h\u001b[>7u");
    const snapshot = await manager.open(openInput());

    expect(snapshot.replayPreamble).toContain("\u001b[?2004h");
    expect(snapshot.replayPreamble).toContain("\u001b[=7;1u");
    expect(snapshot.replayPreamble ?? "").not.toContain("?1002h");

    process.emitData("\u001b[?2004l\u001b[=0;1u");
    const resetSnapshot = await manager.open(openInput());

    expect(resetSnapshot.replayPreamble ?? "").not.toContain("?2004");
    expect(resetSnapshot.replayPreamble ?? "").not.toContain("=7;1u");

    manager.dispose();
  });

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await manager.restart(restartInput());
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    manager.dispose();
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => events.some((event) => event.type === "exited"));
    const reopened = await manager.open(openInput());

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");

    manager.dispose();
  });

  it("ignores trailing writes after terminal exit", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitExit({ exitCode: 0, signal: 0 });

    await expect(manager.write({ threadId: "thread-1", data: "\r" })).resolves.toBeUndefined();
    expect(process.writes).toEqual([]);

    manager.dispose();
  });

  it("emits subprocess activity events when child-process state changes", async () => {
    let hasRunningSubprocess = false;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => hasRunningSubprocess,
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => events.some((event) => event.type === "started"));
    expect(events.some((event) => event.type === "activity")).toBe(false);

    hasRunningSubprocess = true;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
      1_200,
    );

    hasRunningSubprocess = false;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
      1_200,
    );

    manager.dispose();
  });

  it("applies one shared process snapshot to multiple terminals per poll cycle", async () => {
    let captureCount = 0;
    const observer: ProcessChildrenSnapshotObserver = {
      capture: vi.fn(async () => {
        captureCount += 1;
        if (captureCount === 1) return new Map();
        return new Map([
          [9000, [{ pid: 9100, command: "node.exe serve.js" }]],
          [9001, [{ pid: 9101, command: "node.exe build.js" }]],
        ]);
      }),
      retryDelayMs: () => 0,
      dispose: vi.fn(),
    };
    const { manager } = makeManager(5, {
      processSnapshotObserver: observer,
      subprocessPollIntervalMs: 100,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput({ terminalId: "default" }));
    await waitFor(() => captureCount === 1);
    await manager.open(openInput({ terminalId: "sidecar" }));
    await manager.write({ threadId: "thread-1", terminalId: "sidecar", data: "echo active\r" });

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "activity" &&
            event.terminalId === "default" &&
            event.hasRunningSubprocess,
        ) &&
        events.some(
          (event) =>
            event.type === "activity" &&
            event.terminalId === "sidecar" &&
            event.hasRunningSubprocess,
        ),
      1_200,
    );

    expect(observer.capture).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("honors process snapshot retry backoff instead of probing at the terminal cadence", async () => {
    let backoffMs = 0;
    const observer: ProcessChildrenSnapshotObserver = {
      capture: vi.fn(async () => {
        backoffMs = 120;
        return null;
      }),
      retryDelayMs: () => backoffMs,
      dispose: vi.fn(),
    };
    const { manager } = makeManager(5, {
      processSnapshotObserver: observer,
      subprocessPollIntervalMs: 10,
    });

    await manager.open(openInput());
    await waitFor(() => vi.mocked(observer.capture).mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(observer.capture).toHaveBeenCalledTimes(1);

    await waitFor(() => vi.mocked(observer.capture).mock.calls.length === 2, 300);
    manager.dispose();
  });

  it("preserves the last activity state while a shared snapshot is unavailable", async () => {
    let captureCount = 0;
    const observer: ProcessChildrenSnapshotObserver = {
      capture: vi.fn(async () => {
        captureCount += 1;
        return captureCount === 1
          ? new Map([[9000, [{ pid: 9100, command: "node.exe build.js" }]]])
          : null;
      }),
      retryDelayMs: () => 0,
      dispose: vi.fn(),
    };
    const { manager } = makeManager(5, {
      processSnapshotObserver: observer,
      subprocessPollIntervalMs: 20,
    });
    const activityEvents: TerminalEvent[] = [];
    manager.on("event", (event) => {
      if (event.type === "activity") activityEvents.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => captureCount >= 2);

    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0]).toMatchObject({ hasRunningSubprocess: true });
    manager.dispose();
  });

  it("does not brand generic terminals from provider descendants", async () => {
    const { manager } = makeManager(5, {
      subprocessChecker: async () => ({
        cliKind: "codex",
        hasNonProviderSubprocess: true,
        hasProviderDescendant: true,
        hasRunningSubprocess: true,
      }),
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "activity" &&
            event.hasRunningSubprocess === true &&
            event.cliKind === null,
        ),
      1_200,
    );

    expect(events.some((event) => event.type === "activity" && event.cliKind === "codex")).toBe(
      false,
    );
    manager.dispose();
  });

  it("does not brand generic terminals from provider-looking output", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("Claude Code v1.2.3 is available in this dev-server log\n");
    await waitFor(() => events.some((event) => event.type === "output"));

    expect(events.some((event) => event.type === "activity" && event.cliKind === "claude")).toBe(
      false,
    );
    manager.dispose();
  });

  it("clears provider identity when a generic command is submitted", async () => {
    const { manager } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await manager.write({ threadId: "thread-1", data: "codex\r" });
    expect(events.some((event) => event.type === "activity" && event.cliKind === "codex")).toBe(
      true,
    );

    await manager.write({ threadId: "thread-1", data: "bun run dev\r" });
    expect(events.at(-1)).toMatchObject({
      type: "activity",
      cliKind: null,
    });
    manager.dispose();
  });

  it("clears unmanaged provider identity as soon as an observed provider process disappears", async () => {
    let subprocessActivity: TerminalSubprocessActivity = {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
    let providerDescendantPolls = 0;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => {
        if (subprocessActivity.hasProviderDescendant) {
          providerDescendantPolls += 1;
        }
        return subprocessActivity;
      },
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await manager.write({ threadId: "thread-1", data: "codex\r" });
    expect(events.some((event) => event.type === "activity" && event.cliKind === "codex")).toBe(
      true,
    );

    subprocessActivity = {
      cliKind: "codex",
      hasNonProviderSubprocess: false,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    };
    await waitFor(() => providerDescendantPolls > 0, 1_200);

    subprocessActivity = {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "activity" &&
            event.cliKind === null &&
            event.hasRunningSubprocess === false,
        ),
      1_200,
    );

    manager.dispose();
  });

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter } = makeManager(3);
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);

    manager.dispose();
  });

  it("strips replay-unsafe terminal query and reply sequences from persisted history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("prompt ");
    process.emitData("\u001b[32mok\u001b[0m ");
    process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
    process.emitData("\u001b[1;1R");
    process.emitData("done\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("prompt \u001b[32mok\u001b[0m done\n");

    manager.dispose();
  });

  it("abandons a string control sequence that never terminates", () => {
    const { sanitizeTerminalHistoryChunk, maxPendingControlSequenceLength } =
      __terminalHistorySanitizeTesting;
    const chunkLength = 4096;

    // An OSC with no BEL/ST terminator (truncated program, crashed TUI, `cat` on a
    // binary) used to make every later byte accumulate in the carry-over buffer
    // forever: nothing reached scrollback and each flush rescanned the whole buffer.
    let pending = `\u001b]0;${"a".repeat(chunkLength)}`;
    let emitted = "";
    let flushes = 0;
    for (let index = 0; index < 64; index += 1) {
      const result = sanitizeTerminalHistoryChunk(pending, "b".repeat(chunkLength));
      pending = result.pendingControlSequence;
      emitted += result.visibleText;
      if (result.visibleText.length > 0) {
        flushes += 1;
      }
      expect(pending.length).toBeLessThanOrEqual(maxPendingControlSequenceLength);
    }

    expect(flushes).toBeGreaterThan(0);
    expect(emitted.length).toBeGreaterThan(maxPendingControlSequenceLength);
    // Parser state is reset, so ordinary output flows into history again.
    const recovered = sanitizeTerminalHistoryChunk(pending, "recovered\n");
    expect(recovered.visibleText.endsWith("recovered\n")).toBe(true);
    expect(recovered.pendingControlSequence).toBe("");
  });

  it("keeps recording terminal history after an unterminated control sequence", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData(
      `\u001b]0;${"x".repeat(__terminalHistorySanitizeTesting.maxPendingControlSequenceLength + 1)}`,
    );
    // Let the runaway sequence flush on its own batch before the next output.
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.emitData("visible after overflow\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history.endsWith("visible after overflow\n")).toBe(true);

    manager.dispose();
  });

  it("releases cached history when a thread is closed without deleting history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("archived output\n");
    // Archiving closes terminals but keeps their transcripts on disk.
    await manager.close({ threadId: "thread-1" });

    const persistedHistoryByKey = (
      manager as unknown as { persistedHistoryByKey: Map<string, string> }
    ).persistedHistoryByKey;
    expect(
      [...persistedHistoryByKey.keys()].filter((key) => key.startsWith("thread-1\u0000")),
    ).toEqual([]);

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("archived output\n");

    manager.dispose();
  });

  it("strips replay-destructive clears while preserving style sequences", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before clear\n");
    process.emitData("\u001b[H\u001b[2J");
    process.emitData("prompt ");
    process.emitData("\u001b]11;");
    process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
    process.emitData("R\u001b[36mdone\u001b[0m\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before clear\nprompt \u001b[36mdone\u001b[0m\n");

    manager.dispose();
  });

  it("strips cursor save and restore sequences that can blank replayed prompt history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("instant prompt\n");
    process.emitData("\u001b7warning output\n\u001b8\u001b[J");
    process.emitData("final prompt \u001b[35m❯\u001b[0m ");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe(
      "instant prompt\nwarning output\nfinal prompt \u001b[35m❯\u001b[0m ",
    );

    manager.dispose();
  });

  it("strips replay cursor movement while preserving prompt styling", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("first prompt\r");
    process.emitData("\u001b[A\u001b[H\u001b[2K");
    process.emitData("\u001b[0m\u001b[38;5;175m❯\u001b[0m ");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("first prompt\r\u001b[0m\u001b[38;5;175m❯\u001b[0m ");

    manager.dispose();
  });

  it("does not leak final bytes from ESC sequences with intermediate bytes", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(B");
    process.emitData("after\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before \u001b(Bafter\n");

    manager.dispose();
  });

  it("preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(");
    process.emitData("Bafter\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before \u001b(Bafter\n");

    manager.dispose();
  });

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("bye\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    await manager.close({ threadId: "thread-1", deleteHistory: true });
    expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);

    manager.dispose();
  });

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    defaultProcess.emitData("default\n");
    sidecarProcess.emitData("sidecar\n");
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(true);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(false);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(false);

    manager.dispose();
  });

  it("keeps terminals reattached after an archive cleanup fence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-23T20:00:00.000Z"));
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    const archivedAt = "2026-07-23T20:00:05.000Z";
    vi.setSystemTime(new Date("2026-07-23T20:00:10.000Z"));
    await manager.open(openInput({ terminalId: "sidecar" }));

    await manager.closeSessionsOpenedAtOrBefore({
      threadId: "thread-1",
      openedAtOrBefore: archivedAt,
    });

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(false);
    await manager.close({ threadId: "thread-1" });
    manager.dispose();
  });

  it("escalates terminal shutdown to SIGKILL when process does not exit in time", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    await waitFor(() => process.killSignals.includes("SIGKILL"));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");

    manager.dispose();
  });

  it("cancels SIGKILL escalation when the process exits after SIGTERM", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 30 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    process.emitExit({ exitCode: 0, signal: 15 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).not.toContain("SIGKILL");

    manager.dispose();
  });

  it("keeps captured-child SIGKILL escalation after root exit without re-signaling the root", async () => {
    const treeSignals: Array<{
      rootPid: number;
      signal: string;
      descendantPids: number[];
      includeRootTree: boolean | undefined;
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        descendants: [{ pid: 4242, command: "tsdown --watch --clean" }],
      }),
      signal: ({ rootPid, signal, tree, includeRootTree }) => {
        treeSignals.push({
          rootPid,
          signal,
          descendantPids: tree.descendants.map((descendant) => descendant.pid),
          includeRootTree,
        });
      },
    };
    const { manager, ptyAdapter } = makeManager(5, {
      processKillGraceMs: 10,
      processTreeKiller,
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    process.emitExit({ exitCode: 0, signal: 15 });
    await waitFor(() => treeSignals.some((entry) => entry.signal === "SIGKILL"));

    expect(treeSignals).toContainEqual({
      rootPid: process.pid,
      signal: "SIGKILL",
      descendantPids: [4242],
      includeRootTree: false,
    });
    expect(process.killSignals).toEqual(["SIGTERM"]);

    manager.dispose();
  });

  it("shutdown disposal waits for kill escalation before returning", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.disposeForShutdown();

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");
  });

  it("evicts oldest inactive terminal sessions when retention limit is exceeded", async () => {
    const { manager, ptyAdapter } = makeManager(5, { maxRetainedInactiveSessions: 1 });

    await manager.open(openInput({ threadId: "thread-1" }));
    await manager.open(openInput({ threadId: "thread-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    first.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => {
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
      return sessions.size === 1;
    });

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    const keys = [...sessions.keys()];
    expect(keys).toEqual(["thread-2\u0000default"]);

    manager.dispose();
  });

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir } = makeManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const snapshot = await manager.open(openInput());

    expect(snapshot.history).toBe("legacy-line\n");
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(legacyPath)).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(nextPath).mode & 0o777).toBe(0o600);
    }

    manager.dispose();
  });

  it("retries with fallback shells when preferred shell spawn fails", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");

    if (process.platform === "win32") {
      expect(
        ptyAdapter.spawnInputs.some(
          (input) => input.shell === "cmd.exe" || input.shell === "powershell.exe",
        ),
      ).toBe(true);
    } else {
      expect(
        ptyAdapter.spawnInputs.some((input) =>
          ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(input.shell),
        ),
      ).toBe(true);
    }

    manager.dispose();
  });

  it("emits nested PTY spawn failure details", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    ptyAdapter.spawnFailures.push(new Error("native binding missing"));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.message === "Failed to spawn PTY process: native binding missing",
      ),
    ).toBe(true);

    manager.dispose();
  });

  it("filters app runtime env variables from terminal sessions", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("PORT", "5173");
    setEnv("SYNARA_PORT", "3773");
    setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    setEnv("TEST_TERMINAL_KEEP", "keep-me");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.SYNARA_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");

      manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("pins TERM to the embedded renderer and drops host-terminal identity env", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("TERM", "xterm-ghostty");
    setEnv("TERM_PROGRAM", "ghostty");
    setEnv("TERMINFO", "/Applications/Ghostty.app/Contents/Resources/terminfo");
    setEnv("GHOSTTY_RESOURCES_DIR", "/Applications/Ghostty.app/Contents/Resources");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.TERM).toBe(
        process.platform === "win32" ? "xterm-color" : "xterm-256color",
      );
      expect(spawnInput.env.TERM_PROGRAM).toBeUndefined();
      expect(spawnInput.env.TERMINFO).toBeUndefined();
      expect(spawnInput.env.GHOSTTY_RESOURCES_DIR).toBeUndefined();

      manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("pins COLORTERM and drops inherited color-control env", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("NO_COLOR", "1");
    setEnv("FORCE_COLOR", "0");
    setEnv("CLICOLOR", "0");
    setEnv("CLICOLOR_FORCE", "0");
    setEnv("COLORFGBG", "0;15");
    setEnv("COLORTERM", "");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.COLORTERM).toBe("truecolor");
      expect(spawnInput.env.NO_COLOR).toBeUndefined();
      expect(spawnInput.env.FORCE_COLOR).toBeUndefined();
      expect(spawnInput.env.CLICOLOR).toBeUndefined();
      expect(spawnInput.env.CLICOLOR_FORCE).toBeUndefined();
      expect(spawnInput.env.COLORFGBG).toBeUndefined();

      manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("injects runtime env overrides into spawned terminals", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(
      openInput({
        env: {
          SYNARA_PROJECT_ROOT: "/repo",
          SYNARA_WORKTREE_PATH: "/repo/worktree-a",
          CUSTOM_FLAG: "1",
        },
      }),
    );
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.env.SYNARA_PROJECT_ROOT).toBe("/repo");
    expect(spawnInput.env.SYNARA_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(spawnInput.env.CUSTOM_FLAG).toBe("1");

    manager.dispose();
  });

  it("starts zsh as a login shell with prompt spacer disabled", async () => {
    if (process.platform === "win32") return;
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/bin/zsh",
    });
    await manager.open(openInput());
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.shell).toBe("/bin/zsh");
    expect(spawnInput.args).toEqual(["-l", "-o", "nopromptsp"]);

    manager.dispose();
  });
});

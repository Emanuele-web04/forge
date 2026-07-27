import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ApprovalRequestId, ThreadId } from "@synara/contracts";

import {
  buildCodexProcessEnv,
  disableCodexConfigSections,
  resolveCodexBrowserUsePipePath,
} from "./codexProcessEnv";
import {
  buildCodexInitializeParams,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  __codexCliVersionGateTesting,
  CodexAppServerManager,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";
import {
  assertCodexWorkingDirectoryExists,
  formatMissingCodexWorkingDirectoryError,
} from "./codexWorkingDirectory";
import { CodexJsonlFramer, CodexJsonlWriter } from "./codexAppServerTransport";
import { ensureIsolatedScratchWorkspace } from "./scratchWorkspaces";
import { SYNARA_HARNESS_POLICY_MARKER } from "./agentGateway/harnessPolicy.ts";
import { acquireAgentGatewaySessionLease } from "./agentGateway/sessionLease.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const fullAccessTurnOverrides = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
} as const;
const approvalRequiredTurnOverrides = {
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "readOnly" },
} as const;

describe("Codex Synara harness policy", () => {
  it("keeps the same host policy exactly once in default and plan instructions", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      expect(instructions).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(instructions.split(SYNARA_HARNESS_POLICY_MARKER)).toHaveLength(2);
      expect(instructions).toContain("Synara is the host and harness");
      expect(instructions).toContain("one exact synara_create_threads plan");
    }
  });

  it("resolves the gateway endpoint when each session environment is built", async () => {
    const homePath = mkdtempSync(path.join(os.tmpdir(), "synara-codex-gateway-endpoint-"));
    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = path.join(homePath, "synara-home");
    let endpointUrl = "http://127.0.0.1:0/mcp";
    try {
      const manager = new CodexAppServerManager(undefined, {
        agentGatewayMcp: {
          endpointUrl: () => endpointUrl,
          acquireSessionLease: () => ({
            connection: { url: endpointUrl, bearerToken: "token" },
            release: () => undefined,
          }),
        },
      });
      endpointUrl = "http://127.0.0.1:48123/mcp";
      const env = await (
        manager as unknown as {
          buildSessionProcessEnv: (
            homePath: string | undefined,
            token: string | undefined,
          ) => Promise<NodeJS.ProcessEnv>;
        }
      ).buildSessionProcessEnv(homePath, "token");
      const configPath = path.join(env.CODEX_HOME ?? homePath, "config.toml");
      expect(readFileSync(configPath, "utf8")).toContain('url = "http://127.0.0.1:48123/mcp"');
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(homePath, { recursive: true, force: true });
    }
  });
});

function createSendTurnHarness(runtimeMode: "approval-required" | "full-access" = "full-access") {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode,
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    lifecycleGeneration: "generation-request-a",
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession, emitEvent };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingApprovals: new Map(),
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue(undefined);
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createPendingApprovalHarness(
  runtimeMode: "approval-required" | "full-access" = "approval-required",
) {
  const manager = new CodexAppServerManager();
  const context = {
    lifecycleGeneration: "generation-request-a",
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode,
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pendingApprovals: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-approval-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-approval-1"),
          jsonRpcId: 42,
          method: "item/commandExecution/requestApproval" as const,
          requestKind: "command" as const,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    pendingUserInputs: new Map(),
    sessionApprovalOverride: undefined as
      | undefined
      | {
          approvalPolicy: "never";
          sandboxPolicy: { type: "dangerFullAccess" };
        },
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue(undefined);
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return {
    manager,
    context,
    requireSession,
    writeMessage,
    emitEvent,
    sendRequest,
    updateSession,
  };
}

function createCollabNotificationHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_parent",
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    sessionApprovalOverride: undefined as
      | undefined
      | {
          approvalPolicy: "never";
          sandboxPolicy: { type: "dangerFullAccess" };
        },
    collabReceiverTurns: new Map<string, string>(),
    collabReceiverParents: new Map<string, string>(),
    reviewTurnIds: new Set<string>(),
    nextRequestId: 1,
    stopping: false,
  };

  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});
  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (threadId: ThreadId) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue(undefined);

  return { manager, context, emitEvent, updateSession, requireSession, writeMessage };
}

function handleServerNotificationForTest(
  manager: CodexAppServerManager,
  context: unknown,
  notification: Record<string, unknown>,
): void {
  (
    manager as unknown as {
      handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
    }
  ).handleServerNotification(context, notification);
}

async function handleServerRequestForTest(
  manager: CodexAppServerManager,
  context: unknown,
  request: Record<string, unknown>,
): Promise<void> {
  await (
    manager as unknown as {
      handleServerRequest: (context: unknown, request: Record<string, unknown>) => Promise<void>;
    }
  ).handleServerRequest(context, request);
}

function createProcessOutputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    reviewTurnIds: new Set<string>(),
    stopping: false,
  };
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, emitEvent };
}

describe("Codex app-server teardown", () => {
  it("keeps a live process routable when only the last turn status is error", () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5050;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      killed = false;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-codex-failed-turn");
    const context = {
      session: {
        provider: "codex",
        status: "error",
        threadId,
        runtimeMode: "full-access",
        lastError: "Turn failed",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child,
      stdoutFramer: new CodexJsonlFramer(),
      stdinWriter: new CodexJsonlWriter(child.stdin),
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
    };
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      requireSession: (threadId: ThreadId) => unknown;
    };
    internals.sessions.set(threadId, context);

    expect(manager.hasSession(threadId)).toBe(true);
    expect(manager.listSessions()).toEqual([
      expect.objectContaining({ threadId, status: "error" }),
    ]);
    expect(internals.requireSession(threadId)).toBe(context);

    child.stdin.end();

    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toEqual([]);
    expect(() => internals.requireSession(threadId)).toThrow("Session is closed");
  });

  it("makes the session unroutable immediately while stop awaits exit proof", async () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5151;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    let exitProven = false;
    const teardownProcessTree = vi.fn(
      async (input: { readonly rootPid: number; readonly rootExited: Promise<unknown> }) => {
        expect(input.rootPid).toBe(5151);
        await input.rootExited;
        exitProven = true;
        return { escalated: false as const, signalErrors: [] };
      },
    );
    const manager = new CodexAppServerManager(undefined, { teardownProcessTree });
    const threadId = asThreadId("thread-codex-exit-proof");
    const revokeSessionToken = vi.fn();
    const gatewaySessionLease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      threadId,
      "codex",
    );
    const context = {
      gatewaySessionLease,
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child,
      stdoutFramer: new CodexJsonlFramer(),
      stdinWriter: new CodexJsonlWriter(child.stdin),
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    const stopping = manager.stopSession(threadId);
    await Promise.resolve();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(teardownProcessTree).toHaveBeenCalledTimes(1);
    // Unroutable immediately: follow-ups must fall through to thread/resume
    // instead of writing into the dying process's stdin.
    expect(manager.hasSession(threadId)).toBe(false);
    expect(exitProven).toBe(false);

    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopping;
    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(exitProven).toBe(true);
    expect(manager.hasSession(threadId)).toBe(false);
  });

  it("releases the session lease once when the app-server exits spontaneously", () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5252;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-codex-spontaneous-exit");
    const revokeSessionToken = vi.fn();
    const gatewaySessionLease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      threadId,
      "codex",
    );
    const context = {
      gatewaySessionLease,
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child,
      stdoutFramer: new CodexJsonlFramer(),
      stdinWriter: new CodexJsonlWriter(child.stdin),
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
    };
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      attachProcessListeners: (context: unknown) => void;
    };
    internals.sessions.set(threadId, context);
    internals.attachProcessListeners(context);

    child.emit("exit", 1, null);
    child.emit("exit", 1, null);

    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(manager.hasSession(threadId)).toBe(false);
  });
});

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores token usage footers emitted during shutdown", () => {
    const line =
      "^CToken usage: total=360,953 input=336,874 (+ 4,219,648 cached) output=24,079 (reasoning 7,982)";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("normalizes duplicate tool argument parse failures", () => {
    const line =
      "2026-04-11T23:48:45.012578Z ERROR codex_core::tools::router: error=failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 114";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: "Tool call failed because the same argument was sent twice (yield_time_ms).",
    });
  });
});

describe("codex CLI version gate", () => {
  it("memoizes the version probe per binary and shares concurrent probes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-version-"));
    const homePath = path.join(dir, "codex-home");
    mkdirSync(homePath, { recursive: true });
    vi.stubEnv("SYNARA_HOME", path.join(dir, "runtime"));

    const isWindows = process.platform === "win32";
    const counterPath = path.join(dir, "calls.log");
    const binaryPath = path.join(dir, isWindows ? "codex.cmd" : "codex.sh");
    writeFileSync(
      binaryPath,
      isWindows
        ? `@echo off\r\necho x>>"${counterPath}"\r\necho codex-cli 9.9.9\r\n`
        : `#!/bin/sh\necho x >> "${counterPath}"\necho "codex-cli 9.9.9"\n`,
      { mode: 0o755 },
    );
    const probeCount = () => {
      try {
        return readFileSync(counterPath, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    const { assertSupportedCodexCliVersion, reset } = __codexCliVersionGateTesting;
    reset();
    try {
      // Concurrent session starts must share one in-flight probe.
      await Promise.all([
        assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath }),
        assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath }),
      ]);
      expect(probeCount()).toBe(1);

      // A later start/resume reuses the cached verdict instead of spawning again.
      await assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath });
      expect(probeCount()).toBe(1);

      // The per-call working-directory precondition is never served from the cache.
      await expect(
        assertSupportedCodexCliVersion({
          binaryPath,
          cwd: path.join(dir, "missing"),
          homePath,
        }),
      ).rejects.toThrow(formatMissingCodexWorkingDirectoryError(path.join(dir, "missing")));
      expect(probeCount()).toBe(1);

      // An expired verdict re-probes.
      reset();
      await assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath });
      expect(probeCount()).toBe(2);
    } finally {
      reset();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-probes when the binary behind an unchanged path is replaced", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-version-swap-"));
    const homePath = path.join(dir, "codex-home");
    mkdirSync(homePath, { recursive: true });
    vi.stubEnv("SYNARA_HOME", path.join(dir, "runtime"));

    const isWindows = process.platform === "win32";
    const binaryPath = path.join(dir, isWindows ? "codex.cmd" : "codex.sh");
    // The trailing filler keeps the two revisions different in size, so the swap is detected
    // even on a filesystem whose timestamps are too coarse to separate two writes this close.
    const writeBinary = (version: string, filler: string) => {
      writeFileSync(
        binaryPath,
        isWindows
          ? `@echo off\r\nrem ${filler}\r\necho codex-cli ${version}\r\n`
          : `#!/bin/sh\n# ${filler}\necho "codex-cli ${version}"\n`,
        { mode: 0o755 },
      );
    };

    const { assertSupportedCodexCliVersion, reset } = __codexCliVersionGateTesting;
    reset();
    try {
      writeBinary("9.9.9", "original");
      await assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath });

      // An in-place downgrade must not keep riding the cached pass for the rest of the TTL.
      writeBinary("0.1.0", "replaced-in-place-by-a-downgrade");
      await expect(
        assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath }),
      ).rejects.toThrow(/too old for Synara/);
    } finally {
      reset();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-probes when a PATH-resolved codex is replaced behind the same bare name", async () => {
    // The production default is the bare name `codex`, so the fingerprint is only useful if it
    // survives PATH resolution. It is taken from the same env object handed to the spawn a few
    // lines later, which is what keeps it pointed at the binary actually being probed even when
    // that env carries a login-shell PATH the process itself never had.
    const dir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-version-path-"));
    const homePath = path.join(dir, "codex-home");
    mkdirSync(homePath, { recursive: true });
    vi.stubEnv("SYNARA_HOME", path.join(dir, "runtime"));

    const isWindows = process.platform === "win32";
    const binaryPath = path.join(dir, isWindows ? "codex.cmd" : "codex");
    const writeBinary = (version: string, filler: string) => {
      writeFileSync(
        binaryPath,
        isWindows
          ? `@echo off\r\nrem ${filler}\r\necho codex-cli ${version}\r\n`
          : `#!/bin/sh\n# ${filler}\necho "codex-cli ${version}"\n`,
        { mode: 0o755 },
      );
    };
    // Prepended, so this copy wins over any real codex on the machine.
    vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);

    const { assertSupportedCodexCliVersion, reset } = __codexCliVersionGateTesting;
    reset();
    try {
      writeBinary("9.9.9", "original");
      await assertSupportedCodexCliVersion({ binaryPath: "codex", cwd: dir, homePath });

      writeBinary("0.1.0", "replaced-in-place-by-a-downgrade");
      await expect(
        assertSupportedCodexCliVersion({ binaryPath: "codex", cwd: dir, homePath }),
      ).rejects.toThrow(/too old for Synara/);
    } finally {
      reset();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported codex version without caching the failure", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-version-old-"));
    const homePath = path.join(dir, "codex-home");
    mkdirSync(homePath, { recursive: true });
    vi.stubEnv("SYNARA_HOME", path.join(dir, "runtime"));

    const isWindows = process.platform === "win32";
    const counterPath = path.join(dir, "calls.log");
    const binaryPath = path.join(dir, isWindows ? "codex.cmd" : "codex.sh");
    writeFileSync(
      binaryPath,
      isWindows
        ? `@echo off\r\necho x>>"${counterPath}"\r\necho codex-cli 0.1.0\r\n`
        : `#!/bin/sh\necho x >> "${counterPath}"\necho "codex-cli 0.1.0"\n`,
      { mode: 0o755 },
    );
    const probeCount = () => {
      try {
        return readFileSync(counterPath, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    const { assertSupportedCodexCliVersion, reset } = __codexCliVersionGateTesting;
    reset();
    try {
      await expect(
        assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath }),
      ).rejects.toThrow(/too old for Synara/);
      await expect(
        assertSupportedCodexCliVersion({ binaryPath, cwd: dir, homePath }),
      ).rejects.toThrow(/too old for Synara/);
      // Failures are re-probed so installing or upgrading Codex takes effect at once.
      expect(probeCount()).toBe(2);
    } finally {
      reset();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCodexProcessEnv", () => {
  it("hydrates the active custom provider env_key from the effective CODEX_HOME", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          'model_provider = "my-company-proxy"',
          "",
          '[model_providers."my-company-proxy"]',
          'env_key = "MY_COMPANY_PROXY_KEY"',
        ].join("\n"),
        "utf8",
      );

      const readEnvironment = vi.fn(() => ({
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        MY_COMPANY_PROXY_KEY: "proxy-secret",
      }));

      const env = await buildCodexProcessEnv({
        env: {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
        },
        homePath: tempDir,
        platform: "darwin",
        readEnvironment,
      });

      expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
        "PATH",
        "SSH_AUTH_SOCK",
        "MY_COMPANY_PROXY_KEY",
      ]);
      expect(env.CODEX_HOME).toContain("codex-home-overlay");
      expect(env.MY_COMPANY_PROXY_KEY).toBe("proxy-secret");
      expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not read shell env when the provider key is already present", async () => {
    const readEnvironment = vi.fn();

    const env = await buildCodexProcessEnv({
      env: {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        CODEX_HOME: "/tmp/.codex",
        AZURE_OPENAI_API_KEY: "existing-secret",
      },
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.AZURE_OPENAI_API_KEY).toBe("existing-secret");
  });

  it("allows the configured desktop browser-use socket in the Codex sandbox", async () => {
    const env = await buildCodexProcessEnv({
      env: {
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/codex-browser-use/synara.sock",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/existing.sock",
      },
      platform: "darwin",
    });

    expect(env.NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS).toBe("/tmp/codex-browser-use/synara.sock");
  });

  it("forwards the browser-use socket capability to the Browser MCP helper", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          "[mcp_servers.node_repl]",
          'command = "/tmp/node_repl"',
          'env_vars = ["EXISTING_BROWSER_ENV"]',
          "",
          "[mcp_servers.node_repl.env]",
          'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
        ].join("\n"),
        "utf8",
      );

      const env = await buildCodexProcessEnv({
        env: {
          SYNARA_HOME: runtimeHome,
          SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/codex-browser-use/synara.sock",
        },
        homePath: tempDir,
        platform: "darwin",
      });

      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      const overlayConfig = readFileSync(path.join(codexHome, "config.toml"), "utf8");
      expect(overlayConfig).toContain(
        'env_vars = ["NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS", "EXISTING_BROWSER_ENV"]',
      );
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).toContain(
        'env_vars = ["EXISTING_BROWSER_ENV"]',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("resolves the browser-use pipe path from desktop env aliases", () => {
    expect(
      resolveCodexBrowserUsePipePath({
        env: { SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/codex-browser-use/synara.sock" },
        platform: "darwin",
      }),
    ).toBe("/tmp/codex-browser-use/synara.sock");
  });

  it("applies durable section suppressions inside Synara's Codex overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          '[plugins."github@openai-curated"]',
          "enabled = true",
          "",
          '[plugins."historical-plugin@local"]',
          "enabled = true",
        ].join("\n"),
        "utf8",
      );

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(
        path.join(overlayHome, "synara-config-suppressions-v1.json"),
        `${JSON.stringify({
          version: 1,
          sectionHeaders: ['[plugins."historical-plugin@local"]'],
        })}\n`,
        "utf8",
      );

      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlay"));
      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
        '[plugins."historical-plugin@local"]\nenabled = false',
      );
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).toContain(
        '[plugins."historical-plugin@local"]\nenabled = true',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("seeds markerless suppressions for conflicting local browser plugins", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const conflictingHeader = '[plugins."bridge-browser@local"]';
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [conflictingHeader, "enabled = true", "", '[plugins."other@local"]', "enabled = true"].join(
          "\n",
        ),
        "utf8",
      );

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      const overlayConfig = readFileSync(path.join(overlayHome, "config.toml"), "utf8");
      expect(overlayConfig).toContain(`${conflictingHeader}\nenabled = false`);
      expect(overlayConfig).toContain('[plugins."other@local"]\nenabled = true');
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).toContain(
        `${conflictingHeader}\nenabled = true`,
      );
      const suppressionMarker = JSON.parse(
        readFileSync(path.join(overlayHome, "synara-config-suppressions-v1.json"), "utf8"),
      ) as { sectionHeaders?: string[] };
      expect(suppressionMarker.sectionHeaders).toContain(conflictingHeader);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("preserves a recorded suppression after its plugin disappears from source config", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(
        path.join(overlayHome, "synara-config-suppressions-v1.json"),
        `${JSON.stringify({
          version: 1,
          sectionHeaders: ['[plugins."historical-plugin@local"]'],
        })}\n`,
        "utf8",
      );

      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
        '[plugins."historical-plugin@local"]\nenabled = false',
      );
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).not.toContain(
        "historical-plugin@local",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("repairs stale real files in Synara's Codex home overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const sourceMemoryPath = path.join(tempDir, "memories_1.sqlite");
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(sourceMemoryPath, "fresh-source-db", "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayMemoryPath = path.join(overlayHome, "memories_1.sqlite");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(overlayMemoryPath, "stale-overlay-db", "utf8");

      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayMemoryPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(overlayMemoryPath)).toBe(sourceMemoryPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("repairs stale auth.json files in Synara's Codex home overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const sourceAuthPath = path.join(tempDir, "auth.json");
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(sourceAuthPath, '{"tokens":{"access_token":"fresh"}}', "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayAuthPath = path.join(overlayHome, "auth.json");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(overlayAuthPath, '{"tokens":{"access_token":"stale"}}', "utf8");

      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayAuthPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(overlayAuthPath)).toBe(sourceAuthPath);
      expect(readFileSync(overlayAuthPath, "utf8")).toContain("fresh");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("preserves real generated image directories in Synara's Codex home overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      const sourceGeneratedImagesDir = path.join(tempDir, "generated_images");
      mkdirSync(sourceGeneratedImagesDir, { recursive: true });
      writeFileSync(path.join(sourceGeneratedImagesDir, "source.png"), "source-image", "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayGeneratedImagesDir = path.join(overlayHome, "generated_images");
      mkdirSync(overlayGeneratedImagesDir, { recursive: true });
      const overlayImagePath = path.join(overlayGeneratedImagesDir, "overlay.png");
      writeFileSync(overlayImagePath, "overlay-image", "utf8");

      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayGeneratedImagesDir).isDirectory()).toBe(true);
      expect(readFileSync(overlayImagePath, "utf8")).toBe("overlay-image");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("disables only explicitly recorded plugin sections", () => {
    expect(
      disableCodexConfigSections(
        '[plugins."historical-plugin@local"]\nenabled = true\n\n[plugins."other@local"]\nenabled = true',
        ['[plugins."historical-plugin@local"]'],
      ),
    ).toBe(
      '[plugins."historical-plugin@local"]\nenabled = false\n\n[plugins."other@local"]\nenabled = true',
    );
  });
});

describe("handleStdoutLine", () => {
  it("ignores token usage footers emitted on stdout during shutdown", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();

    (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine(
      context,
      "^CToken usage: total=360,953 input=336,874 (+ 4,219,648 cached) output=24,079 (reasoning 7,982)",
    );

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("ignores human-readable diagnostics leaked onto app-server stdout", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();
    const handleStdoutLine = (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine.bind(manager);

    for (const line of ["Reasoning trace", "Reasoning summary", "Command execution"]) {
      handleStdoutLine(context, line);
    }

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("ignores multiline and standalone JSON leaked from command output", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();
    const handleStdoutLine = (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine.bind(manager);

    for (const line of ["{", "[", '{"scripts": {', "{}", "[]", '{"name":"synara"}']) {
      handleStdoutLine(context, line);
    }

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON-looking fragments without poisoning the session", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();

    (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine(context, '{"method":"item/started"');

    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches not-found resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: thread not found")),
    ).toBe(true);
  });

  it("ignores non-resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/start failed: permission denied")),
    ).toBe(false);
  });

  it("ignores non-recoverable resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: timed out waiting for server"),
      ),
    ).toBe(false);
  });
});

describe("readCodexAccountSnapshot", () => {
  it("disables spark for chatgpt plus accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "plus@example.com",
        planType: "plus",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
  });

  it("keeps spark enabled for chatgpt pro accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "pro@example.com",
        planType: "pro",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });

  it("keeps spark enabled for api key accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "apiKey",
      }),
    ).toEqual({
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    });
  });
});

describe("resolveCodexModelForAccount", () => {
  it("falls back from spark to default for unsupported chatgpt plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "plus",
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.5");
  });

  it("keeps spark for supported plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "pro",
        sparkEnabled: true,
      }),
    ).toBe("gpt-5.3-codex-spark");
  });
});

describe("startSession", () => {
  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "synara_desktop",
        title: "Synara Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it("uses an isolated scratch workspace path when no cwd is provided", () => {
    const cwd = ensureIsolatedScratchWorkspace(asThreadId("thread-1"));
    expect(cwd).toContain(`${path.sep}synara-codex-workspaces${path.sep}thread-1`);
  });

  it("reports a missing project working directory instead of a missing Codex CLI", () => {
    const missingCwd = path.join(os.tmpdir(), `synara-missing-cwd-${randomUUID()}`, "old-project");
    expect(() => assertCodexWorkingDirectoryExists(missingCwd)).toThrow(
      formatMissingCodexWorkingDirectoryError(missingCwd),
    );
    expect(() => assertCodexWorkingDirectoryExists(missingCwd)).toThrow(
      /Relocate or reconnect the project/,
    );
    expect(formatMissingCodexWorkingDirectoryError(missingCwd)).not.toMatch(
      /not installed|not executable/i,
    );
  });

  it("accepts an existing project working directory", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "synara-existing-cwd-"));
    try {
      expect(() => assertCodexWorkingDirectoryExists(cwd)).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails session start with missing-cwd guidance instead of missing Codex CLI", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });
    const missingCwd = path.join(
      os.tmpdir(),
      `synara-missing-session-cwd-${randomUUID()}`,
      "old-project",
    );

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-missing-cwd"),
          provider: "codex",
          runtimeMode: "full-access",
          cwd: missingCwd,
          providerOptions: {
            codex: {
              binaryPath: process.execPath,
            },
          },
        }),
      ).rejects.toThrow(formatMissingCodexWorkingDirectoryError(missingCwd));
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message: formatMissingCodexWorkingDirectoryError(missingCwd),
        },
      ]);
      expect(events[0]?.message).not.toMatch(/not installed|not executable/i);
    } finally {
      await manager.stopAll();
    }
  });

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const versionCheck = vi
      .spyOn(
        manager as unknown as {
          assertSupportedCodexCliVersion: (input: {
            binaryPath: string;
            cwd: string;
            homePath?: string;
          }) => void;
        },
        "assertSupportedCodexCliVersion",
      )
      .mockImplementation(() => {
        throw new Error(
          "Codex CLI v0.36.0 is too old for Synara. Upgrade to v0.37.0 or newer and restart Synara.",
        );
      });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.36.0 is too old for Synara. Upgrade to v0.37.0 or newer and restart Synara.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.36.0 is too old for Synara. Upgrade to v0.37.0 or newer and restart Synara.",
        },
      ]);
    } finally {
      versionCheck.mockRestore();
      await manager.stopAll();
    }
  });
});

describe("sendTurn", () => {
  it("clears stale collaboration receiver routing before a new turn", async () => {
    const { manager, context } = createSendTurnHarness();
    context.collabReceiverTurns.set("reused-child", "old-turn");
    context.collabReceiverParents.set("reused-child", "old-parent");

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Start the next turn",
    });

    expect(context.collabReceiverTurns.size).toBe(0);
    expect(context.collabReceiverParents.size).toBe(0);
  });

  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3-codex",
      serviceTier: "fast",
      effort: "high",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("uses approval-required Codex overrides on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness("approval-required");

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Check this before changing files",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...approvalRequiredTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Check this before changing files",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Plan the work",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Plan this with my current session model",
          text_elements: [],
        },
      ],
      model: "gpt-5.2-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.2-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("starts a fresh turn even when the session currently reports running", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    sendRequest.mockResolvedValueOnce({
      turn: { id: "turn_next" },
    });

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Focus on the failing tests first",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.4",
      serviceTier: "fast",
      effort: "high",
      interactionMode: "plan",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_next",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Focus on the failing tests first",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.4",
      serviceTier: "fast",
      effort: "high",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "high",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_next",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });

  it("disables reasoning summaries for Codex Spark", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect the repository",
      model: "gpt-5.3-codex-spark",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({
        model: "gpt-5.3-codex-spark",
        summary: "none",
      }),
    );
  });
});

describe("steerTurn", () => {
  it("steers the active Codex turn when the session is already running", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    context.collabReceiverTurns.set("child_provider_1", "turn_active");
    sendRequest.mockResolvedValueOnce({
      turnId: "turn_active",
    });

    const result = await manager.steerTurn({
      threadId: asThreadId("thread_1"),
      input: "Keep going",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_active",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/steer", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Keep going",
          text_elements: [],
        },
      ],
      expectedTurnId: "turn_active",
    });
    expect(context.collabReceiverTurns.get("child_provider_1")).toBe("turn_active");
  });

  it("requires turn/steer to return the active turn id", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    sendRequest.mockResolvedValueOnce({});

    await expect(
      manager.steerTurn({
        threadId: asThreadId("thread_1"),
        input: "Keep going",
      }),
    ).rejects.toThrow("turn/steer response did not include a turn id.");
  });
});

describe("CodexAppServerManager discovery", () => {
  it("wires model discovery through model/list", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.5",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string) => unknown;
      },
      "resolveContextForDiscovery",
    ).mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({ result: { items: [] } });

    await expect(manager.listModels("thread_1")).resolves.toMatchObject({
      models: [],
      source: "codex-app-server",
      cached: false,
    });
    expect(sendRequest).toHaveBeenCalledWith(context, "model/list", {
      cursor: null,
      limit: 50,
      includeHidden: false,
    });
  });

  it("uses a cwd-scoped discovery session instead of an unrelated active session", async () => {
    const manager = new CodexAppServerManager();
    const activeContext = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_active",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        cwd: "/repo-a",
        resumeCursor: { threadId: "thread_active" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child: {
        killed: false,
      },
      output: {
        close: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      nextRequestId: 1,
      stopping: false,
    };
    const discoveryContext = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "__codex_discovery__:/repo-b",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        cwd: "/repo-b",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child: {
        killed: false,
      },
      output: {
        close: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      nextRequestId: 1,
      stopping: false,
      discovery: true,
    };

    (
      manager as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions.set("thread_active", activeContext);

    const getOrCreateDiscoverySession = vi
      .spyOn(
        manager as unknown as {
          getOrCreateDiscoverySession: (cwd: string) => Promise<unknown>;
        },
        "getOrCreateDiscoverySession",
      )
      .mockResolvedValue(discoveryContext);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          skills: [],
        },
      });

    await manager.listSkills({
      cwd: "/repo-b",
      threadId: "thread_missing",
    });

    expect(getOrCreateDiscoverySession).toHaveBeenCalledWith("/repo-b");
    expect(sendRequest).toHaveBeenCalledWith(discoveryContext, "skills/list", {
      cwds: ["/repo-b"],
    });
  });

  it("skips a dead replacement barrier in the cwd-less discovery fallback", async () => {
    const manager = new CodexAppServerManager();
    const deadContext = {
      session: {
        provider: "codex",
        status: "closed",
        threadId: "thread_dead",
        runtimeMode: "full-access",
      },
      child: {
        exitCode: null,
        signalCode: null,
        killed: true,
        stdin: new PassThrough(),
      },
      stopping: true,
    };
    const discoveryContext = { discovery: true };
    (
      manager as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions.set("thread_dead", deadContext);
    const getOrCreateDiscoverySession = vi
      .spyOn(
        manager as unknown as {
          getOrCreateDiscoverySession: (cwd: string) => Promise<unknown>;
        },
        "getOrCreateDiscoverySession",
      )
      .mockResolvedValue(discoveryContext);

    await expect(
      (
        manager as unknown as {
          resolveContextForDiscovery: () => Promise<unknown>;
        }
      ).resolveContextForDiscovery(),
    ).resolves.toBe(discoveryContext);
    expect(getOrCreateDiscoverySession).toHaveBeenCalledWith(process.cwd());
  });

  it("retries skills/list with cwd when a runtime rejects cwds", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string) => unknown;
      },
      "resolveContextForDiscovery",
    ).mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockRejectedValueOnce(new Error('skills/list failed: invalid params: unknown field "cwds"'))
      .mockResolvedValueOnce({
        result: {
          skills: [
            {
              name: "check-code",
              path: "/Users/test/.codex/skills/check-code/SKILL.md",
            },
          ],
        },
      });

    const result = await manager.listSkills({
      cwd: "/repo",
      threadId: "thread_1",
    });

    expect(sendRequest).toHaveBeenNthCalledWith(1, context, "skills/list", {
      cwds: ["/repo"],
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, context, "skills/list", {
      cwd: "/repo",
    });
    expect(result.skills).toEqual([
      {
        name: "check-code",
        path: "/Users/test/.codex/skills/check-code/SKILL.md",
        enabled: true,
      },
    ]);
  });

  it("wires plugin discovery through plugin/list", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.5",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    const resolveContextForDiscovery = vi
      .spyOn(
        manager as unknown as {
          resolveContextForDiscovery: (threadId?: string, cwd?: string) => unknown;
        },
        "resolveContextForDiscovery",
      )
      .mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({ result: {} });

    await expect(
      manager.listPlugins({
        cwd: "/repo",
        threadId: "thread_1",
        forceRemoteSync: true,
      }),
    ).resolves.toMatchObject({
      marketplaces: [],
      source: "codex-app-server",
      cached: false,
    });
    expect(resolveContextForDiscovery).toHaveBeenCalledWith("thread_1", "/repo");
    expect(sendRequest).toHaveBeenCalledWith(context, "plugin/list", {
      cwds: ["/repo"],
      forceRemoteSync: true,
    });
  });

  it("wires plugin details through plugin/read", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.5",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string, cwd?: string) => unknown;
      },
      "resolveContextForDiscovery",
    ).mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: "/marketplace.json",
            summary: {
              id: "plugin/github",
              name: "github",
              source: { path: "/plugins/github" },
              installed: true,
              enabled: true,
              installPolicy: "INSTALLED_BY_DEFAULT",
              authPolicy: "ON_USE",
            },
          },
        },
      });

    await expect(
      manager.readPlugin({
        marketplacePath: "/marketplace.json",
        pluginName: "github",
      }),
    ).resolves.toMatchObject({
      plugin: {
        marketplaceName: "openai-curated",
        summary: { id: "plugin/github" },
      },
      source: "codex-app-server",
      cached: false,
    });
    expect(sendRequest).toHaveBeenCalledWith(context, "plugin/read", {
      marketplacePath: "/marketplace.json",
      pluginName: "github",
    });
  });
});

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it.skipIf(!process.env.CODEX_BINARY_PATH)("forks a provider thread via thread/fork", async () => {
    const { manager, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_forked",
      },
    });

    const result = await manager.forkThread({
      sourceThreadId: asThreadId("thread_1"),
      sourceResumeCursor: {
        threadId: "thread_1",
      },
      threadId: asThreadId("thread_2"),
      runtimeMode: "full-access",
    });

    expect(sendRequest).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      "thread/fork",
      expect.objectContaining({
        threadId: "thread_1",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    expect(result).toEqual({
      threadId: "thread_2",
      resumeCursor: {
        threadId: "thread_forked",
      },
    });
  });

  it("rolls back turns via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [],
    });
  });

  it("retries review interrupt with the latest review turn from thread/read after timeout", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_review_old";
    context.reviewTurnIds.add("turn_review_old");

    sendRequest
      .mockRejectedValueOnce(new Error("Timed out waiting for turn/interrupt."))
      .mockResolvedValueOnce({
        thread: {
          id: "thread_1",
          turns: [
            {
              id: "turn_review_new",
              items: [{ type: "enteredReviewMode" }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    await manager.interruptTurn(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenNthCalledWith(1, context, "turn/interrupt", {
      threadId: "thread_1",
      turnId: "turn_review_old",
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(3, context, "turn/interrupt", {
      threadId: "thread_1",
      turnId: "turn_review_new",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      activeTurnId: "turn_review_new",
    });
  });

  it("settles review interrupt when thread/read already shows exited review mode", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_review_old";
    context.reviewTurnIds.add("turn_review_old");

    sendRequest
      .mockRejectedValueOnce(new Error("Timed out waiting for turn/interrupt."))
      .mockResolvedValueOnce({
        thread: {
          id: "thread_1",
          turns: [
            {
              id: "turn_review_old",
              items: [{ type: "enteredReviewMode" }, { type: "exitedReviewMode" }],
            },
          ],
        },
      });

    await manager.interruptTurn(asThreadId("thread_1"));

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("emits compaction progress before waiting for thread/compact/start", async () => {
    const { manager, context, sendRequest, updateSession, emitEvent } =
      createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_compact";
    let resolveRequest: (() => void) | undefined;
    sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );

    const compactPromise = manager.compactThread(asThreadId("thread_1"));

    await vi.waitFor(() => {
      expect(sendRequest).toHaveBeenCalledWith(context, "thread/compact/start", {
        threadId: "thread_1",
      });
      expect(updateSession).toHaveBeenCalledWith(context, {
        status: "running",
      });
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "notification",
          provider: "codex",
          threadId: "thread_1",
          method: "thread/compacting",
          message: "Compacting context",
          payload: {
            threadId: "thread_1",
            state: "compacting",
          },
        }),
      );
    });

    resolveRequest?.();
    await compactPromise;
  });

  it("does not claim running status when compacting outside an active turn", async () => {
    const { manager, context, sendRequest, updateSession, emitEvent } =
      createThreadControlHarness();
    sendRequest.mockResolvedValue({});

    await manager.compactThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/compact/start", {
      threadId: "thread_1",
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/compacting",
        message: "Compacting context",
        payload: {
          threadId: "thread_1",
          state: "compacting",
        },
      }),
    );
  });
});

describe("respondToRequest", () => {
  it("keeps acceptForSession active for later Codex turns", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent, sendRequest } =
      createPendingApprovalHarness();

    await manager.respondToRequest(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-approval-1"),
      "acceptForSession",
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        decision: "acceptForSession",
      },
    });
    expect(context.sessionApprovalOverride).toEqual(fullAccessTurnOverrides);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/requestApproval/decision",
        lifecycleGeneration: "generation-request-a",
        requestKind: "command",
        payload: {
          requestId: "req-approval-1",
          requestKind: "command",
          decision: "acceptForSession",
        },
      }),
    );

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue without asking again",
    });

    expect(sendRequest).toHaveBeenLastCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Continue without asking again",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("auto-resolves later approval requests during an always-allowed Codex session", async () => {
    const { manager, context, writeMessage, emitEvent } = createPendingApprovalHarness();

    await manager.respondToRequest(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-approval-1"),
      "acceptForSession",
    );
    writeMessage.mockClear();
    emitEvent.mockClear();

    await (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => Promise<void>;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 99,
      method: "item/fileChange/requestApproval",
      params: {
        turnId: "turn_2",
        itemId: "item_file_change",
        path: "apps/web/src/components/chat/ComposerPendingApprovalActions.tsx",
      },
    });

    expect(context.pendingApprovals.size).toBe(0);
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 99,
      result: {
        decision: "acceptForSession",
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "item/requestApproval/decision",
        turnId: "turn_2",
        itemId: "item_file_change",
        requestKind: "file-change",
        payload: expect.objectContaining({
          requestKind: "file-change",
          decision: "acceptForSession",
        }),
      }),
    );
    expect(
      emitEvent.mock.calls.some(([event]) => (event as { kind?: string }).kind === "request"),
    ).toBe(false);
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
        compat: "Keep current envelope",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: [],
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });

  it("tracks file-read approval requests with the correct method", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    await (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileRead/requestApproval",
      params: {},
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("file-read");
    expect(request?.method).toBe("item/fileRead/requestApproval");
  });
});

describe("collab child conversation routing", () => {
  it("tracks the current collabToolCall receiver shape", () => {
    const { manager, context } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/started",
      params: {
        item: {
          type: "collabToolCall",
          id: "call_collab_current",
          receiverThreadId: "child_provider_current",
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    expect(context.collabReceiverTurns.get("child_provider_current")).toBe("turn_parent");
    expect(context.collabReceiverParents.get("child_provider_current")).toBe("provider_parent");
  });

  it("preserves child notification turn ids and annotates the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
        itemId: "msg_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("routes unmapped child assistant notifications through the active provider thread", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    handleServerNotificationForTest(manager, context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        itemId: "msg_child_unmapped",
        delta: "working",
      },
    });
    handleServerNotificationForTest(manager, context, {
      method: "item/completed",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        item: {
          type: "agentMessage",
          id: "msg_child_unmapped",
          text: "done",
        },
      },
    });

    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_child_unmapped",
        itemId: "msg_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "item/completed",
        turnId: "turn_child_unmapped",
        itemId: "msg_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("does not infer a provider parent for active-parent or inactive-session notifications", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    handleServerNotificationForTest(manager, context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "provider_parent",
        turnId: "turn_parent",
        itemId: "msg_parent",
        delta: "parent",
      },
    });
    context.session.status = "ready";
    handleServerNotificationForTest(manager, context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "another_provider_thread",
        turnId: "turn_other",
        itemId: "msg_other",
        delta: "other",
      },
    });

    const activeParentEvent = emitEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    const inactiveSessionEvent = emitEvent.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(activeParentEvent.providerThreadId).toBe("provider_parent");
    expect(activeParentEvent).not.toHaveProperty("providerParentThreadId");
    expect(inactiveSessionEvent.providerThreadId).toBe("another_provider_thread");
    expect(inactiveSessionEvent).not.toHaveProperty("providerParentThreadId");
  });

  it("prefers a mapped provider parent over the active-provider fallback", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();
    context.collabReceiverParents.set("child_provider_1", "provider_mapped_parent");

    handleServerNotificationForTest(manager, context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "mapped",
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_mapped_parent",
      }),
    );
  });

  it("preserves an inferred child approval route through the decision event", async () => {
    const { manager, context, emitEvent, writeMessage } = createCollabNotificationHarness();

    await handleServerRequestForTest(manager, context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        itemId: "call_child_unmapped",
        command: "bun install",
      },
    });

    const pendingRequest = Array.from(context.pendingApprovals.values())[0];
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    await manager.respondToRequest(asThreadId("thread_1"), pendingRequest.requestId, "accept");

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: { decision: "accept" },
    });
    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "request",
        method: "item/commandExecution/requestApproval",
        turnId: "turn_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "notification",
        method: "item/requestApproval/decision",
        turnId: "turn_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("preserves an unmapped child user-input route through the answered event", async () => {
    const { manager, context, emitEvent, writeMessage } = createCollabNotificationHarness();

    await handleServerRequestForTest(manager, context, {
      id: 43,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        itemId: "tool_child_unmapped",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should this change target?",
            options: [{ label: "child", description: "Only the child thread" }],
          },
        ],
      },
    });

    const pendingRequest = Array.from(context.pendingUserInputs.values())[0];
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    await manager.respondToUserInput(asThreadId("thread_1"), pendingRequest.requestId, {
      scope: "child",
    });

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 43,
      result: {
        answers: {
          scope: { answers: ["child"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "request",
        method: "item/tool/requestUserInput",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "notification",
        method: "item/tool/requestUserInput/answered",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("preserves the inferred child route when session approvals resolve immediately", async () => {
    const { manager, context, emitEvent, writeMessage } = createCollabNotificationHarness();
    context.sessionApprovalOverride = {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };

    await handleServerRequestForTest(manager, context, {
      id: 44,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        itemId: "file_child_unmapped",
        path: "apps/server/src/example.ts",
      },
    });

    expect(context.pendingApprovals.size).toBe(0);
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 44,
      result: { decision: "acceptForSession" },
    });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "item/requestApproval/decision",
        turnId: "turn_child_unmapped",
        itemId: "file_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("suppresses child lifecycle notifications without mutating the parent session state", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("suppresses child lifecycle notifications that arrive before receiver mapping", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_parent";

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_unmapped",
        turn: { id: "turn_child_unmapped" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(context.session.activeTurnId).toBe("turn_parent");
  });

  it("keeps handling lifecycle notifications from the active provider thread", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "provider_parent",
        turn: { id: "turn_parent" },
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/started",
        providerThreadId: "provider_parent",
      }),
    );
    expect(updateSession).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ status: "running", activeTurnId: "turn_parent" }),
    );
  });

  it("suppresses child lifecycle notifications when only the provider parent is known", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();
    context.collabReceiverParents.set("child_provider_1", "provider_parent");

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("forwards child plan notifications so the active plan card can advance", () => {
    // Plan events (`turn/plan/updated`, `item/plan/delta`) are intentionally NOT
    // suppressed for child conversations. Suppressing them freezes the plan UI at
    // its initial all-pending snapshot and prevents the card from ticking off steps
    // as work progresses.
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/plan/updated",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        plan: [{ step: "Plan child work", status: "inProgress" }],
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/plan/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "plan_item_child_1",
        delta: "still planning",
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/plan/updated",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/plan/delta",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
      }),
    );
  });

  it("does not suppress provider-parent-only child notifications without a mapped parent turn", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();
    context.collabReceiverParents.set("child_provider_1", "provider_parent");

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/plan/updated",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        plan: [{ step: "Plan child work", status: "inProgress" }],
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/plan/updated",
        turnId: "turn_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("preserves child approval requests and annotates the parent turn", async () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    await (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => Promise<void>;
      }
    ).handleServerRequest(context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "call_child_1",
        command: "bun install",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        turnId: "turn_child_1",
        itemId: "call_child_1",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
        itemId: "call_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
  });
});

describe("handleServerNotification error normalization", () => {
  it("recovers a missing turn/completed after legacy task_complete", () => {
    vi.useFakeTimers();
    try {
      const manager = new CodexAppServerManager(undefined, {
        taskCompleteFallbackGraceMs: 25,
      });
      const harness = createCollabNotificationHarness();
      const context = harness.context;
      const emitEvent = vi
        .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
        .mockImplementation(() => {});
      const updateSession = vi
        .spyOn(
          manager as unknown as { updateSession: (...args: unknown[]) => void },
          "updateSession",
        )
        .mockImplementation(() => {});

      handleServerNotificationForTest(manager, context, {
        method: "codex/event/task_complete",
        params: {
          id: "turn_parent",
          msg: {
            type: "task_complete",
            turn_id: "turn_parent",
            last_agent_message: "Done.",
          },
        },
      });
      vi.advanceTimersByTime(25);

      expect(updateSession).toHaveBeenCalledWith(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });
      expect(emitEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: "turn/completed",
          turnId: "turn_parent",
          payload: expect.objectContaining({
            recoveredFrom: "codex/event/task_complete",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the task_complete fallback when native turn/completed arrives", () => {
    vi.useFakeTimers();
    try {
      const manager = new CodexAppServerManager(undefined, {
        taskCompleteFallbackGraceMs: 25,
      });
      const context = createCollabNotificationHarness().context;
      const emitEvent = vi
        .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
        .mockImplementation(() => {});

      handleServerNotificationForTest(manager, context, {
        method: "codex/event/task_complete",
        params: {
          id: "turn_parent",
          msg: { type: "task_complete", turn_id: "turn_parent" },
        },
      });
      handleServerNotificationForTest(manager, context, {
        method: "turn/completed",
        params: {
          threadId: "provider_parent",
          turn: { id: "turn_parent", status: "completed" },
        },
      });
      vi.advanceTimersByTime(25);

      expect(
        emitEvent.mock.calls.filter(
          ([event]) => (event as { method?: string }).method === "turn/completed",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles native review when review mode exits", () => {
    const { manager, context, updateSession, emitEvent } = createCollabNotificationHarness();
    context.reviewTurnIds.add("turn_parent");
    context.reviewTurnIds.add("turn_child");
    context.session.activeTurnId = "turn_child";

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "exitedReviewMode",
          id: "turn_parent",
          review: "The working tree is clean.",
        },
        threadId: "provider_parent",
      },
    });

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "turn/completed",
        turnId: "turn_child",
        threadId: "thread_1",
        payload: {
          turn: {
            id: "turn_child",
            status: "completed",
          },
        },
      }),
    );
  });

  it("clears the running session turn when Codex aborts a turn", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/aborted",
      params: {
        threadId: "provider_parent",
        turn: {
          id: "turn_parent",
          status: "interrupted",
        },
      },
    });

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("normalizes duplicate tool argument errors on turn completion", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "provider_parent",
        turn: {
          id: "turn_parent",
          status: "failed",
          error: {
            message:
              "failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 114",
          },
        },
      },
    });

    expect(updateSession).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: "error",
        lastError: "Tool call failed because the same argument was sent twice (yield_time_ms).",
      }),
    );
  });

  it("normalizes duplicate tool argument errors on runtime error notifications", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "error",
      params: {
        threadId: "provider_parent",
        error: {
          message:
            "failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 114",
        },
        willRetry: false,
      },
    });

    expect(updateSession).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: "error",
        lastError: "Tool call failed because the same argument was sent twice (yield_time_ms).",
      }),
    );
  });

  it("does not promote non-fatal tool runtime errors to session lastError", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "error",
      params: {
        threadId: "provider_parent",
        error: {
          message:
            "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
        },
        willRetry: false,
      },
    });

    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe("CodexAppServerManager process teardown", () => {
  it("keeps one stop in flight and publishes closed eagerly", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    const teardownProcessTree = vi.fn(async () => {
      await exitProof;
      return { escalated: false, signalErrors: [] };
    });
    const manager = new CodexAppServerManager(undefined, { teardownProcessTree });
    const threadId = asThreadId("thread-stop-proof");
    const closedEvents: string[] = [];
    manager.on("event", (event) => {
      if (event.method === "session/closed") {
        closedEvents.push(event.method);
      }
    });
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        activeTurnId: "turn-active",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: {
        pid: 42_424,
        exitCode: null,
        signalCode: null,
        once: vi.fn(),
        removeListener: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    const firstStop = manager.stopSession(threadId);
    const concurrentStop = manager.stopSession(threadId);

    expect(teardownProcessTree).toHaveBeenCalledTimes(1);
    // Closed publishes eagerly: the session must become unroutable the moment
    // stop begins, with teardown proof continuing behind the returned promise.
    expect(closedEvents).toEqual(["session/closed"]);
    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
    expect(
      (
        manager as unknown as {
          sessions: Map<ThreadId, unknown>;
        }
      ).sessions.has(threadId),
    ).toBe(true);

    proveExit?.();
    await Promise.all([firstStop, concurrentStop]);

    expect(closedEvents).toEqual(["session/closed"]);
    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("retains the replacement barrier and retries after teardown proof fails", async () => {
    const teardownProcessTree = vi
      .fn()
      .mockRejectedValueOnce(new Error("rootExited=false; surviving process remains"))
      .mockResolvedValueOnce({
        escalated: true,
        signalErrors: [],
      });
    const manager = new CodexAppServerManager(undefined, { teardownProcessTree });
    const threadId = asThreadId("thread-stop-proof-retry");
    const closedEvents: string[] = [];
    manager.on("event", (event) => {
      if (event.method === "session/closed") {
        closedEvents.push(event.method);
      }
    });
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: {
        pid: 42_425,
        exitCode: null,
        signalCode: null,
        once: vi.fn(),
        removeListener: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    await expect(manager.stopSession(threadId)).rejects.toThrow(
      "Failed to prove Codex app-server process-tree exit",
    );
    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
    expect(closedEvents).toEqual(["session/closed"]);

    await manager.stopSession(threadId);
    expect(teardownProcessTree).toHaveBeenCalledTimes(2);
    expect(manager.listSessions()).toHaveLength(0);
    expect(closedEvents).toEqual(["session/closed"]);
  });
});

describe.skipIf(!process.env.CODEX_BINARY_PATH)("startSession live Codex resume", () => {
  it("keeps prior thread history when resuming with a changed runtime mode", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-live-resume-"));
    writeFileSync(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const manager = new CodexAppServerManager();

    try {
      const firstSession = await manager.startSession({
        threadId: asThreadId("thread-live"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        providerOptions: {
          codex: {
            ...(process.env.CODEX_BINARY_PATH ? { binaryPath: process.env.CODEX_BINARY_PATH } : {}),
            ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
          },
        },
      });

      const firstTurn = await manager.sendTurn({
        threadId: firstSession.threadId,
        input: `Reply with exactly the word ALPHA ${randomUUID()}`,
      });

      expect(firstTurn.threadId).toBe(firstSession.threadId);

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(firstSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(0);
        },
        { timeout: 120_000, interval: 1_000 },
      );

      const firstSnapshot = await manager.readThread(firstSession.threadId);
      const originalThreadId = firstSnapshot.threadId;
      const originalTurnCount = firstSnapshot.turns.length;

      await manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
        providerOptions: {
          codex: {
            ...(process.env.CODEX_BINARY_PATH ? { binaryPath: process.env.CODEX_BINARY_PATH } : {}),
            ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
          },
        },
      });

      expect(resumedSession.threadId).toBe(originalThreadId);

      const resumedSnapshotBeforeTurn = await manager.readThread(resumedSession.threadId);
      expect(resumedSnapshotBeforeTurn.threadId).toBe(originalThreadId);
      expect(resumedSnapshotBeforeTurn.turns.length).toBeGreaterThanOrEqual(originalTurnCount);

      await manager.sendTurn({
        threadId: resumedSession.threadId,
        input: `Reply with exactly the word BETA ${randomUUID()}`,
      });

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(resumedSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(originalTurnCount);
        },
        { timeout: 120_000, interval: 1_000 },
      );
    } finally {
      await manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);
});

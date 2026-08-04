// FILE: wsNativeApi.test.ts
// Purpose: Verifies the WebSocket-backed NativeApi adapter and push listener fanout.
// Layer: Web transport tests
// Depends on: wsTransport mock plus contracts channel constants.

import {
  ApprovalRequestId,
  AutomationId,
  AutomationRunId,
  CommandId,
  type ContextMenuItem,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  type WsPushChannel,
  type WsPushData,
  type WsPushMessage,
  WS_CHANNELS,
  WS_METHODS,
  type WsPush,
  type ServerProviderStatus,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const disposeMock = vi.fn();
const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const channelListeners = new Map<string, Set<(message: WsPush) => void>>();
const latestPushByChannel = new Map<string, WsPush>();
const subscribeMock = vi.fn<
  (
    channel: string,
    listener: (message: WsPush) => void,
    options?: { replayLatest?: boolean },
  ) => () => void
>((channel, listener, options) => {
  const listeners = channelListeners.get(channel) ?? new Set<(message: WsPush) => void>();
  listeners.add(listener);
  channelListeners.set(channel, listeners);
  const latest = latestPushByChannel.get(channel);
  if (latest && options?.replayLatest) {
    listener(latest);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      channelListeners.delete(channel);
    }
  };
});

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
      onStateChange() {
        return () => undefined;
      }
      onCompatibilityIssue() {
        return () => undefined;
      }
      onThreadStreamFailure() {
        return () => undefined;
      }
      getLatestPush(channel: string) {
        return latestPushByChannel.get(channel) ?? null;
      }
      getState() {
        return "open" as const;
      }
      dispose = disposeMock;
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

let nextPushSequence = 1;

function emitPush<C extends WsPushChannel>(channel: C, data: WsPushData<C>): void {
  const listeners = channelListeners.get(channel);
  const message = {
    type: "push" as const,
    sequence: nextPushSequence++,
    channel,
    data,
  } as WsPushMessage<C>;
  latestPushByChannel.set(channel, message);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(message);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

const defaultProviders: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  disposeMock.mockReset();
  showContextMenuFallbackMock.mockReset();
  subscribeMock.mockClear();
  channelListeners.clear();
  latestPushByChannel.clear();
  nextPushSequence = 1;
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wsNativeApi", () => {
  it("delivers and caches valid server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    const payload = { cwd: "/tmp/workspace", homeDir: "/Users/tester", projectName: "synara-code" };
    emitPush(WS_CHANNELS.serverWelcome, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it("preserves bootstrap ids from server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      homeDir: "/Users/tester",
      projectName: "synara-code",
      bootstrapProjectId: ProjectId.makeUnsafe("project-1"),
      bootstrapThreadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        homeDir: "/Users/tester",
        projectName: "synara-code",
        bootstrapProjectId: "project-1",
        bootstrapThreadId: "thread-1",
      }),
    );
  });

  it("delivers successive server.welcome payloads to active listeners", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/one",
      homeDir: "/Users/tester",
      projectName: "one",
    });
    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      homeDir: "/Users/tester",
      projectName: "synara-code",
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        homeDir: "/Users/tester",
        projectName: "synara-code",
      }),
    );
  });

  it("delivers and caches valid server.configUpdated payloads", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    const payload = {
      issues: [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: "Entry at index 1 is invalid.",
        },
      ],
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverConfigUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers successive server.configUpdated payloads to active listeners", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    emitPush(WS_CHANNELS.serverConfigUpdated, {
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: defaultProviders,
    });
    emitPush(WS_CHANNELS.serverConfigUpdated, {
      issues: [],
      providers: defaultProviders,
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      issues: [],
      providers: defaultProviders,
    });
  });

  it("delivers and caches provider-only status updates", async () => {
    const { createWsNativeApi, onServerProviderStatusesUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerProviderStatusesUpdated(listener);

    const payload = {
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverProviderStatusesUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerProviderStatusesUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers and caches server settings updates", async () => {
    const { createWsNativeApi, onServerSettingsUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerSettingsUpdated(listener);

    const payload = {
      settings: {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: true,
        defaultThreadEnvMode: "local",
        addProjectBaseDirectory: "",
        textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
        providers: {
          codex: { enabled: true, binaryPath: "codex", homePath: "", customModels: [] },
          claudeAgent: { enabled: true, binaryPath: "claude", launchArgs: "", customModels: [] },
          cursor: { enabled: false, binaryPath: "agent", apiEndpoint: "", customModels: [] },
          antigravity: { enabled: true, binaryPath: "agy", customModels: [] },
          grok: { enabled: true, binaryPath: "grok", customModels: [] },
          droid: { enabled: true, binaryPath: "droid", customModels: [] },
          kilo: {
            enabled: true,
            binaryPath: "kilo",
            serverUrl: "",
            serverPasswordConfigured: false,
            customModels: [],
          },
          opencode: {
            enabled: true,
            binaryPath: "opencode",
            serverUrl: "",
            serverPasswordConfigured: false,
            experimentalWebSockets: false,
            customModels: [],
          },
          pi: { enabled: true, binaryPath: "pi", agentDir: "", customModels: [] },
        },
        skills: { disabled: [] },
      },
    } as const;
    emitPush(WS_CHANNELS.serverSettingsUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerSettingsUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("forwards valid terminal and orchestration events", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();
    const onActionProgress = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    expect(channelListeners.has(ORCHESTRATION_WS_CHANNELS.domainEvent)).toBe(false);
    const unsubscribeDomainEvent = api.orchestration.onDomainEvent(onDomainEvent);
    expect(channelListeners.get(ORCHESTRATION_WS_CHANNELS.domainEvent)?.size).toBe(1);
    api.git.onActionProgress(onActionProgress);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitPush(WS_CHANNELS.terminalEvent, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, orchestrationEvent);
    emitPush(WS_CHANNELS.gitActionProgress, {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });

    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledTimes(1);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
    unsubscribeDomainEvent();
    expect(channelListeners.has(ORCHESTRATION_WS_CHANNELS.domainEvent)).toBe(false);
    expect(onActionProgress).toHaveBeenCalledTimes(1);
    expect(onActionProgress).toHaveBeenCalledWith({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });
  });

  it("forwards automation requests and events", async () => {
    requestMock.mockResolvedValue({ definitions: [], runs: [] });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onAutomationEvent = vi.fn();
    const unsubscribe = api.automation.onEvent(onAutomationEvent);

    await api.automation.list({ projectId: ProjectId.makeUnsafe("project-1") });
    await api.automation.getMemory({
      automationId: AutomationId.makeUnsafe("automation-1"),
    });
    await api.automation.runNow({ automationId: AutomationId.makeUnsafe("automation-1") });
    await api.automation.markRunRead({
      runId: AutomationRunId.makeUnsafe("automation-run-1"),
      unread: false,
    });
    await api.automation.archiveRun({
      runId: AutomationRunId.makeUnsafe("automation-run-1"),
      archived: true,
    });
    await api.automation.resolveProposal({
      automationId: AutomationId.makeUnsafe("automation-1"),
      resolution: "accepted",
    });

    const event = {
      type: "definition-deleted",
      automationId: AutomationId.makeUnsafe("automation-1"),
    } as const;
    emitPush(WS_CHANNELS.automationEvent, event);
    unsubscribe();
    emitPush(WS_CHANNELS.automationEvent, {
      type: "definition-deleted",
      automationId: AutomationId.makeUnsafe("automation-2"),
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.automationList, {
      projectId: "project-1",
    });
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.automationGetMemory, {
      automationId: "automation-1",
    });
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.automationRunNow, {
      automationId: "automation-1",
    });
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.automationMarkRunRead, {
      runId: "automation-run-1",
      unread: false,
    });
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.automationArchiveRun, {
      runId: "automation-run-1",
      archived: true,
    });
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.automationResolveProposal, {
      automationId: "automation-1",
      resolution: "accepted",
    });
    expect(onAutomationEvent).toHaveBeenCalledTimes(1);
    expect(onAutomationEvent).toHaveBeenCalledWith(event);
  });

  it("wraps orchestration dispatch commands in the command envelope", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      kind: "project",
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
  });

  it("forwards terminal output ACKs to the websocket transport", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const input = { threadId: "thread-1", terminalId: "default", bytes: 4096 };
    await api.terminal.ackOutput(input);

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.terminalAckOutput, input);
  });

  it("omits null user-input answers before dispatching to orchestration", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    const command = {
      type: "thread.user-input.respond",
      commandId: CommandId.makeUnsafe("cmd-user-input-null"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("request-1"),
      answers: {
        Language: null,
        Runtime: "Bun",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: {
        ...command,
        answers: {
          Runtime: "Bun",
        },
      },
    });
  });

  it("forwards workspace file writes to the websocket project method", async () => {
    requestMock.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsWriteFile, {
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards workspace file reads to the websocket project method", async () => {
    requestMock.mockResolvedValue({
      relativePath: "src/app.ts",
      contents: "export {};\n",
      truncated: false,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.readFile({
      cwd: "/tmp/project",
      relativePath: "src/app.ts",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsReadFile, {
      cwd: "/tmp/project",
      relativePath: "src/app.ts",
    });
  });

  it("forwards local preview grant creation to the websocket project method", async () => {
    requestMock.mockResolvedValue({
      grant: "grant-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.createLocalFilePreviewGrant({
      path: "/Users/tester/Downloads/shot.png",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsCreateLocalFilePreviewGrant, {
      path: "/Users/tester/Downloads/shot.png",
    });
  });

  it("forwards project script discovery to the websocket project method", async () => {
    requestMock.mockResolvedValue({ targets: [] });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.discoverScripts({
      cwd: "/tmp/project",
      depth: 2,
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsDiscoverScripts, {
      cwd: "/tmp/project",
      depth: 2,
    });
  });

  it("forwards server environment requests to the websocket server method", async () => {
    requestMock.mockResolvedValue({
      environmentId: "environment-1",
      label: "Test Host",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.38",
      capabilities: { repositoryIdentity: true },
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.server.getEnvironment();

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.serverGetEnvironment);
  });

  it("uses websocket RPC for external MCP management in packaged and browser builds", async () => {
    requestMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ integration: { integrationId: "integration-1" } })
      .mockResolvedValueOnce({ revoked: true })
      .mockResolvedValueOnce({ integration: { integrationId: "integration-1" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const createInput = {
      name: "Desktop MCP",
      capabilities: ["projects:read", "tasks:create", "tasks:read"] as const,
      projectIds: [ProjectId.makeUnsafe("project-1")],
    };

    await api.server.listExternalMcpIntegrations();
    await api.server.createExternalMcpIntegration(createInput);
    await api.server.revokeExternalMcpIntegration({ integrationId: "integration-1" });
    await api.server.refreshExternalMcpPairing({ integrationId: "integration-1" });

    expect(requestMock).toHaveBeenNthCalledWith(1, WS_METHODS.serverListExternalMcpIntegrations);
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      WS_METHODS.serverCreateExternalMcpIntegration,
      createInput,
    );
    expect(requestMock).toHaveBeenNthCalledWith(3, WS_METHODS.serverRevokeExternalMcpIntegration, {
      integrationId: "integration-1",
    });
    expect(requestMock).toHaveBeenNthCalledWith(4, WS_METHODS.serverRefreshExternalMcpPairing, {
      integrationId: "integration-1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches auth session state over HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "synara_session",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const result = await api.server.getAuthSession();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(result).toMatchObject({ authenticated: false });
  });

  it("posts auth bootstrap payloads over HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const result = await api.server.bootstrapAuth({ credential: "PAIRINGTOKEN" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      }),
    );
    expect(result).toMatchObject({ authenticated: true, sessionMethod: "browser-session-cookie" });
  });

  it("logs out over HTTP and disposes the authenticated websocket transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await expect(api.server.logoutAuthSession()).resolves.toEqual({ revoked: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("uses no client timeout for git.runStackedAction", async () => {
    requestMock.mockResolvedValue({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: { status: "created", commitSha: "abc1234", subject: "Test" },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.git.runStackedAction({ actionId: "action-1", cwd: "/repo", action: "commit" });

    expect(requestMock).toHaveBeenCalledWith(
      WS_METHODS.gitRunStackedAction,
      { actionId: "action-1", cwd: "/repo", action: "commit" },
      { timeoutMs: null },
    );
  });

  it("forwards cancellable GitHub project provisioning and its progress events", async () => {
    const input = {
      operationId: "operation-1",
      repository: "openai/codex",
      destinationParent: "/projects",
      directoryName: "codex",
      commandId: CommandId.makeUnsafe("command-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      newProjectSpaceId: null,
      defaultModelSelection: { provider: "codex" as const, model: "gpt-5" },
      createdAt: "2026-08-04T00:00:00.000Z",
    };
    const result = {
      operationId: input.operationId,
      repository: input.repository,
      workspaceRoot: "/projects/codex",
      projectId: input.projectId,
      checkout: "created" as const,
    };
    requestMock.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const progressListener = vi.fn();
    api.projects.onProvisionProgress(progressListener);
    const controller = new AbortController();

    await expect(
      api.projects.provisionFromGitHub(input, { signal: controller.signal }),
    ).resolves.toEqual(result);
    emitPush(WS_CHANNELS.projectProvisionProgress, {
      operationId: input.operationId,
      kind: "phase",
      phase: "cloning",
      message: "Cloning openai/codex",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsProvisionFromGitHub, input, {
      timeoutMs: null,
      signal: controller.signal,
    });
    expect(progressListener).toHaveBeenCalledWith({
      operationId: input.operationId,
      kind: "phase",
      phase: "cloning",
      message: "Cloning openai/codex",
    });
  });

  it("forwards full-thread diff requests to the orchestration websocket method", async () => {
    requestMock.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards provider delivery inspection and reconciliation", async () => {
    requestMock.mockResolvedValue([]);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await api.orchestration.listProviderDeliveryBlockers({
      threadId: ThreadId.makeUnsafe("thread-1"),
      limit: 10,
    });
    await api.orchestration.reconcileProviderDelivery({
      eventSequence: 42,
      threadId: ThreadId.makeUnsafe("thread-1"),
      expectedState: "uncertain",
      outcome: "safe_retry",
      note: "The provider confirms it did not accept the command.",
    });

    expect(requestMock).toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
      { threadId: "thread-1", limit: 10 },
    );
    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery, {
      eventSequence: 42,
      threadId: "thread-1",
      expectedState: "uncertain",
      outcome: "safe_retry",
      note: "The provider confirms it did not accept the command.",
    });
  });

  it("forwards browser webview detach requests to the desktop bridge", async () => {
    const detachWebview = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        browser: {
          detachWebview,
        },
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const input = {
      threadId: ThreadId.makeUnsafe("thread-1"),
      tabId: "tab-1",
      webContentsId: 42,
    };
    await api.browser.detachWebview(input);

    expect(detachWebview).toHaveBeenCalledWith(input);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("forwards browser annotation sessions and events to the desktop bridge", async () => {
    const threadId = ThreadId.makeUnsafe("thread-annotations");
    const session = {
      sessionId: "session-a",
      threadId,
      tabId: "tab-a",
      document: {
        token: "document-a",
        key: `sha256:${"0".repeat(64)}`,
        url: "https://example.test/",
      },
      source: { url: "https://example.test/", pageTitle: "Example" },
    };
    const start = vi.fn().mockResolvedValue(session);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const syncMarkers = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    const onEvent = vi.fn(() => unsubscribe);
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        browser: {
          annotations: { start, cancel, syncMarkers, onEvent },
        },
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const startInput = {
      threadId,
      tabId: "tab-a",
      theme: {
        mode: "dark" as const,
        accent: "rgb(96, 115, 204)",
        surface: "rgb(27, 27, 29)",
        text: "rgb(250, 250, 250)",
        mutedText: "rgb(161, 161, 170)",
        border: "rgb(63, 63, 70)",
        focusBorder: "rgb(96, 115, 204)",
        primary: "rgb(250, 250, 250)",
        primaryText: "rgb(24, 24, 27)",
      },
    };
    const cancelInput = { threadId, tabId: "tab-a" };
    const projection = {
      threadId,
      tabId: "tab-a",
      version: 7,
      markers: [],
    };
    const listener = vi.fn();

    await expect(api.browser.annotations.start(startInput)).resolves.toEqual(session);
    await api.browser.annotations.cancel(cancelInput);
    await api.browser.annotations.syncMarkers(projection);
    expect(api.browser.annotations.onEvent(listener)).toBe(unsubscribe);
    expect(start).toHaveBeenCalledWith(startInput);
    expect(cancel).toHaveBeenCalledWith(cancelInput);
    expect(syncMarkers).toHaveBeenCalledWith(projection);
    expect(onEvent).toHaveBeenCalledWith(listener);
  });

  it("keeps a blank fallback browser tab after closing the last tab", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const opened = await api.browser.open({ threadId });
    const tabId = opened.activeTabId;

    expect(tabId).toBeTruthy();
    const nextState = await api.browser.closeTab({ threadId, tabId: tabId ?? "" });

    expect(nextState.open).toBe(true);
    expect(nextState.tabs).toHaveLength(1);
    expect(nextState.activeTabId).toBe(nextState.tabs[0]?.id);
    expect(nextState.tabs[0]?.url).toBe("about:blank");
  });

  it("forwards context menu metadata to desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        showContextMenu,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", separatorBefore: true, destructive: true },
      ],
      { x: 200, y: 300 },
    );

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", separatorBefore: true, destructive: true },
      ],
      { x: 200, y: 300 },
    );
  });

  it("uses fallback context menu when desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }], {
      x: 20,
      y: 30,
    });

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });

  it("uses the bounded server upload even when the desktop bridge is available", async () => {
    const transcribeVoice = vi.fn().mockResolvedValue({ text: "hello" });
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret",
        server: {
          transcribeVoice,
        },
      },
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.server.transcribeVoice({
      provider: "codex",
      cwd: "/repo",
      audioBase64: "UklGRgAAAAAAAAAAAAAAAAAAAAA=",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });

    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/voice/transcribe?"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
    );
  });

  it("prewarms voice state through the persistent server transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await api.server.prewarmVoice?.({ provider: "codex", cwd: "/repo" });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.serverPrewarmVoice, {
      provider: "codex",
      cwd: "/repo",
    });
  });

  it("uses the bounded HTTP upload instead of WebSocket RPC for browser voice", async () => {
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const result = await api.server.transcribeVoice({
      provider: "codex",
      cwd: "/repo",
      audioBase64: "AQID",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });

    expect(result).toEqual({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/voice/transcribe?"),
      expect.objectContaining({ method: "POST", body: Uint8Array.from([1, 2, 3]) }),
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
    );
  });

  it("falls back to WebSocket voice RPC when an older server has no upload route", async () => {
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    requestMock.mockResolvedValueOnce({ text: "legacy transport" });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const input = {
      provider: "codex" as const,
      cwd: "/repo",
      audioBase64: "AQID",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    };

    await expect(api.server.transcribeVoice(input)).resolves.toEqual({
      text: "legacy transport",
    });
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.serverTranscribeVoice, input, {
      timeoutMs: null,
    });
  });
});

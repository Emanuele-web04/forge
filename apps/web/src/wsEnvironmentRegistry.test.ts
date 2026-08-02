// FILE: wsEnvironmentRegistry.test.ts
// Purpose: Verifies the environment-keyed WS client registry and its push listener fanout.
// Layer: Web transport tests
// Depends on: wsTransport mock plus contracts channel constants.

import {
  ApprovalRequestId,
  AutomationId,
  AutomationRunId,
  CommandId,
  type ContextMenuItem,
  EnvironmentId,
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

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("remote-environment");

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const disposeMock = vi.fn();
const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
// Each mock transport owns its own push state, mirroring the real transport:
// channel identity is (environmentId, channel), so two environments must not
// share listener sets or replay caches.
interface MockTransportState {
  readonly environmentId: string;
  readonly channelListeners: Map<string, Set<(message: WsPush) => void>>;
  readonly latestPushByChannel: Map<string, WsPush>;
  readonly threadStreamFailureListeners: Set<(failure: unknown) => void>;
}

const mockTransportsByEnvironmentId = new Map<string, MockTransportState>();
// Lets a test drive one environment's transport into "disposed" to exercise the
// registry's replacement path.
const mockTransportStateByEnvironmentId = new Map<string, "open" | "disposed">();

function mockTransportFor(environmentId = "local"): MockTransportState {
  const state = mockTransportsByEnvironmentId.get(environmentId);
  if (!state) throw new Error(`No mock transport for environment ${environmentId}`);
  return state;
}

const channelListeners = {
  get: (channel: string) => mockTransportFor().channelListeners.get(channel),
  has: (channel: string) => mockTransportFor().channelListeners.has(channel),
};
const subscribeMock = vi.fn();

// The registry reaches the store through a deferred dynamic import to avoid a
// module cycle (see wsEnvironmentRegistry). Importing the real store in this
// node-environment suite fails at its top-level `window.addEventListener`, so
// the store is mocked and the registry's calls are observed directly.
const clearEnvironmentShellFenceMock = vi.fn();
const discardEnvironmentProjectionMock = vi.fn();

vi.mock("./store", () => ({
  useStore: {
    getState: () => ({
      clearEnvironmentShellFence: clearEnvironmentShellFenceMock,
      discardEnvironmentProjection: discardEnvironmentProjectionMock,
    }),
  },
}));

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      readonly environmentId: string;
      private readonly state: MockTransportState;
      request = requestMock;
      dispose = disposeMock;

      constructor(options?: string | { environmentId?: string }) {
        this.environmentId =
          (typeof options === "string" ? undefined : options?.environmentId) ?? "local";
        this.state = {
          environmentId: this.environmentId,
          channelListeners: new Map(),
          latestPushByChannel: new Map(),
          threadStreamFailureListeners: new Set(),
        };
        mockTransportsByEnvironmentId.set(this.environmentId, this.state);
      }

      subscribe(
        channel: string,
        listener: (message: WsPush) => void,
        options?: { replayLatest?: boolean },
      ) {
        subscribeMock(channel, listener, options);
        const listeners =
          this.state.channelListeners.get(channel) ?? new Set<(message: WsPush) => void>();
        listeners.add(listener);
        this.state.channelListeners.set(channel, listeners);
        const latest = this.state.latestPushByChannel.get(channel);
        if (latest && options?.replayLatest) {
          listener(latest);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            this.state.channelListeners.delete(channel);
          }
        };
      }
      onStateChange() {
        return () => undefined;
      }
      onCompatibilityIssue() {
        return () => undefined;
      }
      onBuildSkew() {
        return () => undefined;
      }
      onThreadStreamFailure(listener: (failure: unknown) => void) {
        this.state.threadStreamFailureListeners.add(listener);
        return () => {
          this.state.threadStreamFailureListeners.delete(listener);
        };
      }
      getLatestPush(channel: string) {
        return this.state.latestPushByChannel.get(channel) ?? null;
      }
      getState() {
        return mockTransportStateByEnvironmentId.get(this.state.environmentId) ?? "open";
      }
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

let nextPushSequence = 1;

function emitPush<C extends WsPushChannel>(
  channel: C,
  data: WsPushData<C>,
  options?: { readonly environmentId?: string; readonly sequence?: number },
): void {
  const state = mockTransportFor(options?.environmentId);
  const message = {
    type: "push" as const,
    sequence: options?.sequence ?? nextPushSequence++,
    channel,
    data,
  } as WsPushMessage<C>;
  state.latestPushByChannel.set(channel, message);
  for (const listener of state.channelListeners.get(channel) ?? []) {
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
  mockTransportsByEnvironmentId.clear();
  mockTransportStateByEnvironmentId.clear();
  nextPushSequence = 1;
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wsEnvironmentRegistry", () => {
  it("delivers and caches valid server.welcome payloads", async () => {
    const { localWsEnvironmentClient, onServerWelcome } = await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
    const { localWsEnvironmentClient, onServerWelcome } = await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
    const { localWsEnvironmentClient, onServerWelcome } = await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
    const { localWsEnvironmentClient, onServerConfigUpdated } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
    const { localWsEnvironmentClient, onServerConfigUpdated } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
    const { localWsEnvironmentClient, onServerProviderStatusesUpdated } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
    const { localWsEnvironmentClient, onServerSettingsUpdated } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
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
        remoteHosts: [],
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
    const input = { threadId: "thread-1", terminalId: "default", bytes: 4096 };
    await api.terminal.ackOutput(input);

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.terminalAckOutput, input);
  });

  it("omits null user-input answers before dispatching to orchestration", async () => {
    requestMock.mockResolvedValue(undefined);
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;

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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
    await api.projects.createLocalFilePreviewGrant({
      path: "/Users/tester/Downloads/shot.png",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsCreateLocalFilePreviewGrant, {
      path: "/Users/tester/Downloads/shot.png",
    });
  });

  it("forwards project script discovery to the websocket project method", async () => {
    requestMock.mockResolvedValue({ targets: [] });
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
    await api.git.runStackedAction({ actionId: "action-1", cwd: "/repo", action: "commit" });

    expect(requestMock).toHaveBeenCalledWith(
      WS_METHODS.gitRunStackedAction,
      { actionId: "action-1", cwd: "/repo", action: "commit" },
      { timeoutMs: null },
    );
  });

  it("forwards full-thread diff requests to the orchestration websocket method", async () => {
    requestMock.mockResolvedValue({ diff: "patch" });
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;

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

    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
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

    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
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
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
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

    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
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

    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }], {
      x: 20,
      y: 30,
    });

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });

  it("uses the desktop voice bridge when available", async () => {
    const transcribeVoice = vi.fn().mockResolvedValue({ text: "hello" });
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        server: {
          transcribeVoice,
        },
      },
    });

    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
    await api.server.transcribeVoice({
      provider: "codex",
      cwd: "/repo",
      audioBase64: "UklGRgAAAAAAAAAAAAAAAAAAAAA=",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });

    expect(transcribeVoice).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/repo",
      audioBase64: "UklGRgAAAAAAAAAAAAAAAAAAAAA=",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
    );
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

    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const api = localWsEnvironmentClient().api;
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
  it("keeps one client per environment and reuses the local entry", async () => {
    const { ensureWsEnvironmentClient, localWsEnvironmentClient, listWsEnvironmentClients } =
      await import("./wsEnvironmentRegistry");

    const local = localWsEnvironmentClient();
    const remote = ensureWsEnvironmentClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      url: "wss://remote.example/",
    });

    expect(localWsEnvironmentClient()).toBe(local);
    expect(remote).not.toBe(local);
    expect(listWsEnvironmentClients()).toEqual([local, remote]);
    expect(local.environmentId).toBe("local");
    expect(remote.environmentId).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("never crosses push channels between environments", async () => {
    const { ensureWsEnvironmentClient, localWsEnvironmentClient, onServerWelcome } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://remote/" });

    const localListener = vi.fn();
    const remoteListener = vi.fn();
    onServerWelcome(localListener);
    onServerWelcome(remoteListener, { environmentId: REMOTE_ENVIRONMENT_ID });

    emitPush(
      WS_CHANNELS.serverWelcome,
      { cwd: "/remote", homeDir: "/home/remote", projectName: "remote" },
      { environmentId: REMOTE_ENVIRONMENT_ID },
    );

    expect(remoteListener).toHaveBeenCalledTimes(1);
    expect(localListener).not.toHaveBeenCalled();
  });

  it("replays only the subscribed environment's cached push to late subscribers", async () => {
    const { ensureWsEnvironmentClient, localWsEnvironmentClient, onServerWelcome } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://remote/" });

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/local",
      homeDir: "/home/local",
      projectName: "local",
    });
    emitPush(
      WS_CHANNELS.serverWelcome,
      { cwd: "/remote", homeDir: "/home/remote", projectName: "remote" },
      { environmentId: REMOTE_ENVIRONMENT_ID },
    );

    const lateRemote = vi.fn();
    onServerWelcome(lateRemote, { environmentId: REMOTE_ENVIRONMENT_ID });

    expect(lateRemote).toHaveBeenCalledTimes(1);
    expect(lateRemote).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/remote" }));
  });

  it("keeps sequence spaces separate: identical sequences on both environments both deliver", async () => {
    // Sequences are per-server autoincrement values. A shared counter would let
    // one environment's number suppress the other's push as a duplicate.
    const { ensureWsEnvironmentClient, localWsEnvironmentClient, onServerSettingsUpdated } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://remote/" });

    const localListener = vi.fn();
    const remoteListener = vi.fn();
    onServerSettingsUpdated(localListener);
    onServerSettingsUpdated(remoteListener, { environmentId: REMOTE_ENVIRONMENT_ID });

    const settings = { settings: {} } as WsPushData<typeof WS_CHANNELS.serverSettingsUpdated>;
    emitPush(WS_CHANNELS.serverSettingsUpdated, settings, { sequence: 1 });
    emitPush(WS_CHANNELS.serverSettingsUpdated, settings, {
      environmentId: REMOTE_ENVIRONMENT_ID,
      sequence: 1,
    });

    expect(localListener).toHaveBeenCalledTimes(1);
    expect(remoteListener).toHaveBeenCalledTimes(1);
  });

  it("disposes one environment without touching the others", async () => {
    const {
      ensureWsEnvironmentClient,
      getWsEnvironmentClient,
      localWsEnvironmentClient,
      removeWsEnvironmentClient,
      onServerWelcome,
    } = await import("./wsEnvironmentRegistry");

    const local = localWsEnvironmentClient();
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://remote/" });
    const localListener = vi.fn();
    onServerWelcome(localListener);

    await removeWsEnvironmentClient(REMOTE_ENVIRONMENT_ID);

    expect(getWsEnvironmentClient(REMOTE_ENVIRONMENT_ID)).toBeUndefined();
    expect(getWsEnvironmentClient(LOCAL_ENVIRONMENT_ID)).toBe(local);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/local",
      homeDir: "/home/local",
      projectName: "local",
    });
    expect(localListener).toHaveBeenCalledTimes(1);
  });

  it("yields an inert subscription for an unregistered remote environment", async () => {
    // Auto-connecting an unknown id would open a socket to the wrong server:
    // only the local environment is addressable without registration.
    const { onServerWelcome, getWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const listener = vi.fn();
    const unsubscribe = onServerWelcome(listener, { environmentId: REMOTE_ENVIRONMENT_ID });

    expect(getWsEnvironmentClient(REMOTE_ENVIRONMENT_ID)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("routes thread stream failures to the owning environment only", async () => {
    const { ensureWsEnvironmentClient, localWsEnvironmentClient, onThreadStreamFailure } =
      await import("./wsEnvironmentRegistry");

    localWsEnvironmentClient();
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://remote/" });

    const localListener = vi.fn();
    const remoteListener = vi.fn();
    onThreadStreamFailure(localListener);
    onThreadStreamFailure(remoteListener, { environmentId: REMOTE_ENVIRONMENT_ID });

    const failure = { threadId: "thread-1", code: null, error: new Error("dead") };
    for (const listener of mockTransportFor(REMOTE_ENVIRONMENT_ID).threadStreamFailureListeners) {
      listener(failure);
    }

    expect(remoteListener).toHaveBeenCalledWith(failure);
    expect(localListener).not.toHaveBeenCalled();
  });

  it("replaces a disposed entry instead of handing out a dead socket", async () => {
    const { localWsEnvironmentClient, resetWsEnvironmentRegistry } =
      await import("./wsEnvironmentRegistry");

    const first = localWsEnvironmentClient();
    await resetWsEnvironmentRegistry();
    const second = localWsEnvironmentClient();

    expect(second).not.toBe(first);
  });

  it("sends every HTTP-backed server method to the environment's own host", async () => {
    // A remote client resolving HTTP through the page's ambient WS URL would
    // post its payload — session credentials, recorded audio — to the LOCAL
    // server. Every HTTP-backed route must address its own environment.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false, revoked: true, text: "hi" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ensureWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    const remote = ensureWsEnvironmentClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      url: "wss://b.example/",
    });

    await remote.api.server.getAuthSession();
    await remote.api.server.bootstrapAuth({ credential: "TOKEN" });
    await remote.api.server.logoutAuthSession().catch(() => undefined);
    await remote.api.server
      .transcribeVoice({
        provider: "codex",
        cwd: "/tmp",
        mimeType: "audio/webm",
        sampleRateHz: 48_000,
        durationMs: 1_000,
        audioBase64: "",
      })
      .catch(() => undefined);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/b\.example\//);
    }
  });

  it("leaves the local environment's HTTP requests on their existing relative paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { localWsEnvironmentClient } = await import("./wsEnvironmentRegistry");

    await localWsEnvironmentClient().api.server.getAuthSession();

    // Regression bar: the single-local-server case is byte-identical.
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.anything());
  });

  it("discards an environment's resume cursors when it is removed", async () => {
    const { ensureWsEnvironmentClient, removeWsEnvironmentClient } =
      await import("./wsEnvironmentRegistry");
    const { threadDetailResumeCursors, resetThreadDetailResumeCursorsForTests } =
      await import("./threadDetailResumeCursors");
    resetThreadDetailResumeCursorsForTests();

    const threadId = ThreadId.makeUnsafe("thread-1");
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://e/" });
    threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID).set(threadId, 100);

    await removeWsEnvironmentClient(REMOTE_ENVIRONMENT_ID);
    // Re-registered as a different server instance whose journal is unrelated:
    // the fresh transport has never seen the old instance id, so it cannot
    // detect the change. The cursor must already be gone.
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://e/" });

    expect(threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID).buildSubscribeInput(threadId)).toEqual({
      threadId,
    });
  });

  it("discards resume cursors when a disposed entry is replaced automatically", async () => {
    const { ensureWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    const { threadDetailResumeCursors, resetThreadDetailResumeCursorsForTests } =
      await import("./threadDetailResumeCursors");
    resetThreadDetailResumeCursorsForTests();

    const threadId = ThreadId.makeUnsafe("thread-2");
    const client = ensureWsEnvironmentClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      url: "wss://e/",
    });
    threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID).set(threadId, 100);
    mockTransportStateByEnvironmentId.set(REMOTE_ENVIRONMENT_ID, "disposed");

    const replacement = ensureWsEnvironmentClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      url: "wss://e/",
    });

    expect(replacement).not.toBe(client);
    expect(threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID).buildSubscribeInput(threadId)).toEqual({
      threadId,
    });
  });

  it("discards an environment's projected rows when it is torn down", async () => {
    // The counterpart to the replacement case below: on explicit teardown no
    // snapshot is coming, so the rows must go with the fence or the sidebar
    // keeps listing threads owned by a server that is gone, with nothing left
    // to prune them. A reviewer added this call to the replacement path and
    // every test still passed, so the lifecycle was unpinned in both
    // directions.
    const { ensureWsEnvironmentClient, removeWsEnvironmentClient } =
      await import("./wsEnvironmentRegistry");
    discardEnvironmentProjectionMock.mockClear();

    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://e/" });
    await removeWsEnvironmentClient(REMOTE_ENVIRONMENT_ID);

    await vi.waitFor(() => {
      expect(discardEnvironmentProjectionMock).toHaveBeenCalledWith(REMOTE_ENVIRONMENT_ID);
    });
  });

  it("clears the snapshot fence when a disposed entry is replaced automatically", async () => {
    // The fence is the same generation-sensitive state as the resume cursors
    // above and fails the same way, but this lifecycle transition handled only
    // the cursors. A replacement transport has no earlier server-instance id to
    // compare against, so it cannot detect a restored server whose journal
    // restarts low: a surviving high-water mark rejects every snapshot from the
    // replacement as stale and the sidebar renders rows that server no longer
    // has, with no error surfaced.
    const { ensureWsEnvironmentClient } = await import("./wsEnvironmentRegistry");
    clearEnvironmentShellFenceMock.mockClear();
    discardEnvironmentProjectionMock.mockClear();

    const client = ensureWsEnvironmentClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      url: "wss://e/",
    });
    mockTransportStateByEnvironmentId.set(REMOTE_ENVIRONMENT_ID, "disposed");

    const replacement = ensureWsEnvironmentClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      url: "wss://e/",
    });
    expect(replacement).not.toBe(client);

    await vi.waitFor(() => {
      expect(clearEnvironmentShellFenceMock).toHaveBeenCalledWith(REMOTE_ENVIRONMENT_ID);
    });
    // Fence only: the replacement resubscribes immediately, so discarding the
    // rows would blank the sidebar for that round trip and buy nothing. That is
    // what separates this path from an explicit teardown.
    expect(discardEnvironmentProjectionMock).not.toHaveBeenCalled();
  });

  it("notifies registry listeners so aggregation can re-derive", async () => {
    const { ensureWsEnvironmentClient, onWsEnvironmentRegistryChange, removeWsEnvironmentClient } =
      await import("./wsEnvironmentRegistry");

    const listener = vi.fn();
    onWsEnvironmentRegistryChange(listener);

    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://e/" });
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    await removeWsEnvironmentClient(REMOTE_ENVIRONMENT_ID);
    expect(listener).toHaveBeenCalled();
  });

  it("resolves the env-unaware default to the local environment entry", async () => {
    // Pins the single-local-server path directly: an env-unaware subscription
    // and an explicitly-local one must reach the same client and the same
    // channel registry, not merely "both happen to work".
    const { ensureWsEnvironmentClient, localWsEnvironmentClient, onServerWelcome } =
      await import("./wsEnvironmentRegistry");

    const viaDefault = localWsEnvironmentClient();
    const viaExplicit = ensureWsEnvironmentClient({ environmentId: LOCAL_ENVIRONMENT_ID });
    expect(viaExplicit).toBe(viaDefault);

    const defaultListener = vi.fn();
    const explicitListener = vi.fn();
    onServerWelcome(defaultListener);
    onServerWelcome(explicitListener, { environmentId: LOCAL_ENVIRONMENT_ID });

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp",
      homeDir: "/home/tester",
      projectName: "synara",
    });

    expect(defaultListener).toHaveBeenCalledTimes(1);
    expect(explicitListener).toHaveBeenCalledTimes(1);
  });

  it("drops registry-change subscribers on reset instead of notifying them", async () => {
    // Regression: reset notified listeners while disposing. A subscriber from
    // the outgoing generation (a React effect whose unmount had not run yet)
    // would re-attach against clients already being torn down, leaving stale
    // stream wiring that made the next mount's snapshots never reach the
    // store. The browser suite saw this as tests hanging on UI that could not
    // render. Reset is a full teardown: subscribers go with it.
    const { ensureWsEnvironmentClient, onWsEnvironmentRegistryChange, resetWsEnvironmentRegistry } =
      await import("./wsEnvironmentRegistry");

    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://e/" });
    const listener = vi.fn();
    onWsEnvironmentRegistryChange(listener);

    await resetWsEnvironmentRegistry();
    expect(listener).not.toHaveBeenCalled();

    // And the subscription is gone, not merely quiet during the reset.
    ensureWsEnvironmentClient({ environmentId: REMOTE_ENVIRONMENT_ID, url: "wss://e/" });
    expect(listener).not.toHaveBeenCalled();
  });
});

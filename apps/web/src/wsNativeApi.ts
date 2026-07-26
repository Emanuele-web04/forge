// FILE: wsNativeApi.ts
// Purpose: NativeApi implementation backed by the browser WebSocket RPC transport.
// Layer: Web transport adapter
// Exports: createWsNativeApi and event subscription helpers for server push channels.

import {
  type AuthBearerBootstrapResult,
  type AuthBootstrapInput,
  type AuthBootstrapResult,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthLogoutResult,
  type AuthPairingCredentialResult,
  type AuthPairingLink,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
  type ExternalMcpCreateIntegrationInput,
  type ExternalMcpCreateIntegrationResult,
  type ExternalMcpIntegration,
  type ExternalMcpRefreshPairingInput,
  type ExternalMcpRevokeIntegrationInput,
  type ThreadId,
  type ThreadBrowserState,
  type GitActionProgressEvent,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ProjectDevServerEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerLifecycleStreamEvent,
  type ServerSettingsUpdatedPayload,
  type ServerVoiceTranscriptionResult,
  type TerminalEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
  type AutomationStreamEvent,
} from "@synara/contracts";
import { VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";

import { showConfirmDialogFallback } from "./confirmDialogFallback";
import { showContextMenuFallback } from "./contextMenuFallback";
import { requireHttpExternalUrl } from "./lib/externalUrl";
import { WsTransport, type WsThreadStreamFailure } from "./wsTransport";
import { emitWsCompatibilityIssue, emitWsTransportState } from "./wsTransportEvents";
import { resolveWsHttpUrl } from "./lib/wsHttpUrl";

export type { WsThreadStreamFailure } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;

function createListenerRegistry<T>() {
  const listeners = new Set<(payload: T) => void>();
  return {
    get size() {
      return listeners.size;
    },
    subscribe(listener: (payload: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(payload: T) {
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch {
          // A listener must not prevent delivery to the remaining subscribers.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

function subscribeWithReplay<T>(input: {
  readonly registry: {
    subscribe: (listener: (payload: T) => void) => () => unknown;
  };
  readonly listener: (payload: T) => void;
  readonly latest: T | null;
}): () => void {
  const unsubscribe = input.registry.subscribe(input.listener);
  if (input.latest) {
    try {
      input.listener(input.latest);
    } catch {
      // Replay follows the same listener isolation as live delivery.
    }
  }
  return () => void unsubscribe();
}

const welcomeListeners = createListenerRegistry<WsWelcomePayload>();
const serverConfigUpdatedListeners = createListenerRegistry<ServerConfigUpdatedPayload>();
const serverProviderStatusesUpdatedListeners =
  createListenerRegistry<ServerProviderStatusesUpdatedPayload>();
const serverMaintenanceUpdatedListeners = createListenerRegistry<ServerLifecycleStreamEvent>();
const serverSettingsUpdatedListeners = createListenerRegistry<ServerSettingsUpdatedPayload>();
const gitActionProgressListeners = createListenerRegistry<GitActionProgressEvent>();

function omitNullUserInputAnswers(
  command: Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0],
) {
  if (command.type !== "thread.user-input.respond") {
    return command;
  }

  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}
const terminalEventListeners = createListenerRegistry<TerminalEvent>();
const projectDevServerEventListeners = createListenerRegistry<ProjectDevServerEvent>();
const automationEventListeners = createListenerRegistry<AutomationStreamEvent>();
const orchestrationDomainEventListeners = createListenerRegistry<OrchestrationEvent>();
const orchestrationShellEventListeners = createListenerRegistry<OrchestrationShellStreamItem>();
const orchestrationThreadEventListeners = createListenerRegistry<OrchestrationThreadStreamItem>();
const threadStreamFailureListeners = createListenerRegistry<WsThreadStreamFailure>();
const fallbackBrowserStateListeners = createListenerRegistry<ThreadBrowserState>();
const fallbackBrowserStates = new Map<ThreadId, ThreadBrowserState>();

function clearWsNativeApiListeners(): void {
  welcomeListeners.clear();
  serverConfigUpdatedListeners.clear();
  serverProviderStatusesUpdatedListeners.clear();
  serverMaintenanceUpdatedListeners.clear();
  serverSettingsUpdatedListeners.clear();
  gitActionProgressListeners.clear();
  terminalEventListeners.clear();
  projectDevServerEventListeners.clear();
  automationEventListeners.clear();
  orchestrationDomainEventListeners.clear();
  orchestrationShellEventListeners.clear();
  orchestrationThreadEventListeners.clear();
  threadStreamFailureListeners.clear();
  fallbackBrowserStateListeners.clear();
}

function defaultBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function defaultBrowserTitle(url: string): string {
  if (url === "about:blank") {
    return "New tab";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

async function requestAuthJson<T>(
  path: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
  } = {},
): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    ...(hasBody
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Auth request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function requestVoiceTranscriptionUpload(
  input: Parameters<NativeApi["server"]["transcribeVoice"]>[0],
) {
  const params = new URLSearchParams({
    provider: input.provider,
    cwd: input.cwd,
    mimeType: input.mimeType,
    sampleRateHz: String(input.sampleRateHz),
    durationMs: String(input.durationMs),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  const decoded = atob(input.audioBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  const response = await fetch(
    resolveWsHttpUrl(`${VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH}?${params.toString()}`),
    { method: "POST", credentials: "include", body: bytes },
  );
  const payload = (await response.json().catch(() => null)) as
    | ServerVoiceTranscriptionResult
    | { readonly error?: unknown }
    | null;
  if (!response.ok || !payload || !("text" in payload)) {
    const message =
      payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Voice transcription failed with status ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

function createFallbackTab(url = "about:blank") {
  return {
    id: crypto.randomUUID(),
    url,
    title: defaultBrowserTitle(url),
    status: "live" as const,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url,
    lastError: null,
  };
}

function cloneBrowserState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function getFallbackBrowserState(threadId: ThreadId): ThreadBrowserState {
  const existing = fallbackBrowserStates.get(threadId);
  if (existing) {
    return existing;
  }
  const initial = defaultBrowserState(threadId);
  fallbackBrowserStates.set(threadId, initial);
  return initial;
}

function emitFallbackBrowserState(threadId: ThreadId): ThreadBrowserState {
  const state = cloneBrowserState(getFallbackBrowserState(threadId));
  fallbackBrowserStateListeners.emit(state);
  return state;
}

function markFallbackBrowserStateChanged(state: ThreadBrowserState): void {
  state.version += 1;
}

function ensureFallbackBrowserWorkspace(threadId: ThreadId): ThreadBrowserState {
  const state = getFallbackBrowserState(threadId);
  if (state.tabs.length === 0) {
    const tab = createFallbackTab();
    state.tabs = [tab];
    state.activeTabId = tab.id;
  }
  state.open = true;
  return state;
}

function resolveFallbackBrowserTab(state: ThreadBrowserState, tabId?: string) {
  const existing =
    (tabId ? state.tabs.find((tab) => tab.id === tabId) : undefined) ??
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  if (existing) {
    return existing;
  }
  const tab = createFallbackTab();
  state.tabs = [tab];
  state.activeTabId = tab.id;
  state.open = true;
  return tab;
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  const latestWelcome = instance?.transport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
  return subscribeWithReplay({ registry: welcomeListeners, listener, latest: latestWelcome });
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  const latestConfig =
    instance?.transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverConfigUpdatedListeners,
    listener,
    latest: latestConfig,
  });
}

/**
 * Subscribe to provider status updates without forcing a full config reload.
 */
export function onServerProviderStatusesUpdated(
  listener: (payload: ServerProviderStatusesUpdatedPayload) => void,
): () => void {
  const latestProviderStatuses =
    instance?.transport.getLatestPush(WS_CHANNELS.serverProviderStatusesUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverProviderStatusesUpdatedListeners,
    listener,
    latest: latestProviderStatuses,
  });
}

export function onServerMaintenanceUpdated(
  listener: (payload: ServerLifecycleStreamEvent) => void,
): () => void {
  const latestMaintenance =
    instance?.transport.getLatestPush(WS_CHANNELS.serverMaintenanceUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverMaintenanceUpdatedListeners,
    listener,
    latest: latestMaintenance,
  });
}

export function onServerSettingsUpdated(
  listener: (payload: ServerSettingsUpdatedPayload) => void,
): () => void {
  const latestSettings =
    instance?.transport.getLatestPush(WS_CHANNELS.serverSettingsUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverSettingsUpdatedListeners,
    listener,
    latest: latestSettings,
  });
}

/**
 * Subscribe to unrecoverable per-thread stream failures (retries and reconnect
 * exhausted). Lets thread-detail consumers surface a failed hydration state
 * instead of rendering an empty conversation.
 */
export function onThreadStreamFailure(
  listener: (failure: WsThreadStreamFailure) => void,
): () => void {
  const unsubscribe = threadStreamFailureListeners.subscribe(listener);
  return () => void unsubscribe();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    if (instance.transport.getState() !== "disposed") {
      return instance.api;
    }
    instance = null;
  }

  const transport = new WsTransport();
  let unsubscribeDomainEventTransport: (() => void) | null = null;
  transport.onStateChange((state) => emitWsTransportState(state));
  transport.onCompatibilityIssue((issue) => emitWsCompatibilityIssue(issue), {
    replayCurrent: true,
  });

  transport.subscribe(WS_CHANNELS.serverWelcome, (message) => {
    welcomeListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverConfigUpdated, (message) => {
    serverConfigUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverProviderStatusesUpdated, (message) => {
    serverProviderStatusesUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverMaintenanceUpdated, (message) => {
    serverMaintenanceUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverSettingsUpdated, (message) => {
    serverSettingsUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.gitActionProgress, (message) => {
    gitActionProgressListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.terminalEvent, (message) => {
    terminalEventListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.projectDevServerEvent, (message) => {
    projectDevServerEventListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.automationEvent, (message) => {
    automationEventListeners.emit(message.data);
  });
  transport.subscribe(ORCHESTRATION_WS_CHANNELS.shellEvent, (message) => {
    orchestrationShellEventListeners.emit(message.data);
  });
  transport.subscribe(ORCHESTRATION_WS_CHANNELS.threadEvent, (message) => {
    orchestrationThreadEventListeners.emit(message.data);
  });
  transport.onThreadStreamFailure((failure) => {
    threadStreamFailureListeners.emit(failure);
  });
  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      saveFile: async (input) => {
        if (window.desktopBridge?.saveFile) {
          return window.desktopBridge.saveFile(input);
        }
        const blob = new Blob([input.contents], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = input.defaultFilename;
          anchor.click();
        } finally {
          URL.revokeObjectURL(url);
        }
        return null;
      },
      confirm: async (message) => {
        return showConfirmDialogFallback(message);
      },
    },
    terminal: {
      open: (input) => transport.request(WS_METHODS.terminalOpen, input),
      write: (input) => transport.request(WS_METHODS.terminalWrite, input),
      ackOutput: (input) => transport.request(WS_METHODS.terminalAckOutput, input),
      resize: (input) => transport.request(WS_METHODS.terminalResize, input),
      clear: (input) => transport.request(WS_METHODS.terminalClear, input),
      restart: (input) => transport.request(WS_METHODS.terminalRestart, input),
      close: (input) => transport.request(WS_METHODS.terminalClose, input),
      onEvent: terminalEventListeners.subscribe,
    },
    projects: {
      discoverScripts: (input) => transport.request(WS_METHODS.projectsDiscoverScripts, input),
      listDirectories: (input) => transport.request(WS_METHODS.projectsListDirectories, input),
      searchEntries: (input) => transport.request(WS_METHODS.projectsSearchEntries, input),
      searchLocalEntries: (input) =>
        transport.request(WS_METHODS.projectsSearchLocalEntries, input),
      readFile: (input) => transport.request(WS_METHODS.projectsReadFile, input),
      createLocalFilePreviewGrant: (input) =>
        transport.request(WS_METHODS.projectsCreateLocalFilePreviewGrant, input),
      writeFile: (input) => transport.request(WS_METHODS.projectsWriteFile, input),
      runDevServer: (input) => transport.request(WS_METHODS.projectsRunDevServer, input),
      stopDevServer: (input) => transport.request(WS_METHODS.projectsStopDevServer, input),
      listDevServers: () => transport.request(WS_METHODS.projectsListDevServers),
      onDevServerEvent: projectDevServerEventListeners.subscribe,
    },
    filesystem: {
      browse: (input) => transport.request(WS_METHODS.filesystemBrowse, input),
    },
    studio: {
      listThreadOutputs: (input) => transport.request(WS_METHODS.studioListThreadOutputs, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openExternal: async (url) => {
        const externalUrl = requireHttpExternalUrl(url);
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(externalUrl);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        // Some mobile browsers can return null here even when the tab opens.
        // Avoid false negatives and let the browser handle popup policy.
        window.open(externalUrl, "_blank", "noopener,noreferrer");
      },
      showInFolder: async (path) => {
        if (window.desktopBridge) {
          await window.desktopBridge.showInFolder(path);
        }
        // No-op in browser - this is a desktop-only feature
      },
    },
    git: {
      githubRepository: (input) => transport.request(WS_METHODS.gitGithubRepository, input),
      pull: (input) => transport.request(WS_METHODS.gitPull, input),
      status: (input) => transport.request(WS_METHODS.gitStatus, input),
      readWorkingTreeDiff: (input) => transport.request(WS_METHODS.gitReadWorkingTreeDiff, input),
      workingTreeDiffStats: (input) => transport.request(WS_METHODS.gitWorkingTreeDiffStats, input),
      summarizeDiff: (input) =>
        transport.request(WS_METHODS.gitSummarizeDiff, input, {
          timeoutMs: null,
        }),
      runStackedAction: (input) =>
        transport.request(WS_METHODS.gitRunStackedAction, input, {
          timeoutMs: null,
        }),
      listBranches: (input) => transport.request(WS_METHODS.gitListBranches, input),
      createWorktree: (input) => transport.request(WS_METHODS.gitCreateWorktree, input),
      createDetachedWorktree: (input) =>
        transport.request(WS_METHODS.gitCreateDetachedWorktree, input),
      removeWorktree: (input) => transport.request(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => transport.request(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => transport.request(WS_METHODS.gitCheckout, input),
      stashAndCheckout: (input) => transport.request(WS_METHODS.gitStashAndCheckout, input),
      stashDrop: (input) => transport.request(WS_METHODS.gitStashDrop, input),
      stashInfo: (input) => transport.request(WS_METHODS.gitStashInfo, input),
      removeIndexLock: (input) => transport.request(WS_METHODS.gitRemoveIndexLock, input),
      init: (input) => transport.request(WS_METHODS.gitInit, input),
      stageFiles: (input) => transport.request(WS_METHODS.gitStageFiles, input),
      unstageFiles: (input) => transport.request(WS_METHODS.gitUnstageFiles, input),
      handoffThread: (input) => transport.request(WS_METHODS.gitHandoffThread, input),
      resolvePullRequest: (input) => transport.request(WS_METHODS.gitResolvePullRequest, input),
      pullRequestSnapshot: (input) => transport.request(WS_METHODS.gitPullRequestSnapshot, input),
      preparePullRequestThread: (input) =>
        transport.request(WS_METHODS.gitPreparePullRequestThread, input),
      onActionProgress: gitActionProgressListeners.subscribe,
    },
    pullRequests: {
      list: (input) => transport.request(WS_METHODS.pullRequestsList, input),
      reviewRequestCount: (input) =>
        transport.request(WS_METHODS.pullRequestsReviewRequestCount, input),
      detail: (input) => transport.request(WS_METHODS.pullRequestsDetail, input),
      diff: (input) => transport.request(WS_METHODS.pullRequestsDiff, input),
      action: (input) =>
        transport.request(WS_METHODS.pullRequestsAction, input, { timeoutMs: null }),
      comment: (input) => transport.request(WS_METHODS.pullRequestsComment, input),
      setPinned: (input) => transport.request(WS_METHODS.pullRequestsSetPinned, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position);
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => transport.request(WS_METHODS.serverGetConfig),
      getEnvironment: () => transport.request(WS_METHODS.serverGetEnvironment),
      getSettings: () => transport.request(WS_METHODS.serverGetSettings),
      updateSettings: (input) => transport.request(WS_METHODS.serverUpdateSettings, input),
      getAuthSession: () => requestAuthJson<AuthSessionState>("/api/auth/session"),
      bootstrapAuth: (input: AuthBootstrapInput) =>
        requestAuthJson<AuthBootstrapResult>("/api/auth/bootstrap", {
          method: "POST",
          body: input,
        }),
      bootstrapBearerAuth: (input: AuthBootstrapInput) =>
        requestAuthJson<AuthBearerBootstrapResult>("/api/auth/bootstrap/bearer", {
          method: "POST",
          body: input,
        }),
      issueAuthWebSocketToken: () =>
        requestAuthJson<AuthWebSocketTokenResult>("/api/auth/ws-token", { method: "POST" }),
      createAuthPairingToken: (input?: AuthCreatePairingCredentialInput) =>
        requestAuthJson<AuthPairingCredentialResult>("/api/auth/pairing-token", {
          method: "POST",
          ...(input ? { body: input } : {}),
        }),
      listAuthPairingLinks: () =>
        requestAuthJson<ReadonlyArray<AuthPairingLink>>("/api/auth/pairing-links"),
      revokeAuthPairingLink: (input: AuthRevokePairingLinkInput) =>
        requestAuthJson<{ revoked: boolean }>("/api/auth/pairing-links/revoke", {
          method: "POST",
          body: input,
        }),
      listAuthClients: () => requestAuthJson<ReadonlyArray<AuthClientSession>>("/api/auth/clients"),
      revokeAuthClient: (input: AuthRevokeClientSessionInput) =>
        requestAuthJson<{ revoked: boolean }>("/api/auth/clients/revoke", {
          method: "POST",
          body: input,
        }),
      revokeOtherAuthClients: () =>
        requestAuthJson<{ revokedCount: number }>("/api/auth/clients/revoke-others", {
          method: "POST",
        }),
      logoutAuthSession: async () => {
        const result = await requestAuthJson<AuthLogoutResult>("/api/auth/logout", {
          method: "POST",
        });
        await transport.dispose();
        return result;
      },
      listExternalMcpIntegrations: () =>
        transport.request(WS_METHODS.serverListExternalMcpIntegrations),
      createExternalMcpIntegration: (input: ExternalMcpCreateIntegrationInput) =>
        transport.request(WS_METHODS.serverCreateExternalMcpIntegration, input),
      revokeExternalMcpIntegration: (input: ExternalMcpRevokeIntegrationInput) =>
        transport.request(WS_METHODS.serverRevokeExternalMcpIntegration, input),
      refreshExternalMcpPairing: (input: ExternalMcpRefreshPairingInput) =>
        transport.request(WS_METHODS.serverRefreshExternalMcpPairing, input),
      refreshProviders: () => transport.request(WS_METHODS.serverRefreshProviders),
      // Provider updates run up to 2 minutes server-side; callers wrap this in
      // withProviderUpdateTimeout, which owns the client-side watchdog.
      updateProvider: (input) =>
        transport.request(WS_METHODS.serverUpdateProvider, input, { timeoutMs: null }),
      listWorktrees: () => transport.request(WS_METHODS.serverListWorktrees),
      listLocalServers: () => transport.request(WS_METHODS.serverListLocalServers),
      stopLocalServer: (input) => transport.request(WS_METHODS.serverStopLocalServer, input),
      getProviderUsageSnapshot: (input) =>
        transport.request(WS_METHODS.serverGetProviderUsageSnapshot, input),
      listProviderUsage: (input) => transport.request(WS_METHODS.serverListProviderUsage, input),
      getDiagnostics: () => transport.request(WS_METHODS.serverGetDiagnostics),
      generateThreadRecap: (input) =>
        transport.request(WS_METHODS.serverGenerateThreadRecap, input, {
          timeoutMs: null,
        }),
      generateAutomationIntent: (input) =>
        transport.request(WS_METHODS.serverGenerateAutomationIntent, input, {
          timeoutMs: null,
        }),
      transcribeVoice: (input) => {
        if (window.desktopBridge?.server?.transcribeVoice) {
          return window.desktopBridge.server.transcribeVoice(input);
        }
        return requestVoiceTranscriptionUpload(input);
      },
      upsertKeybinding: (input) => transport.request(WS_METHODS.serverUpsertKeybinding, input),
    },
    stats: {
      getProfileStats: (input) => transport.request(WS_METHODS.statsGetProfileStats, input),
      getProfileTokenStats: (input) =>
        transport.request(WS_METHODS.statsGetProfileTokenStats, input),
    },
    provider: {
      getComposerCapabilities: (input) =>
        transport.request(WS_METHODS.providerGetComposerCapabilities, input),
      // Compaction is capped server-side per provider (ACP providers allow up
      // to the 10-minute turn-idle ceiling), so the server owns this bound.
      compactThread: (input) =>
        transport.request(WS_METHODS.providerCompactThread, input, { timeoutMs: null }),
      listCommands: (input) => transport.request(WS_METHODS.providerListCommands, input),
      listSkills: (input) => transport.request(WS_METHODS.providerListSkills, input),
      listSkillsCatalog: (input) => transport.request(WS_METHODS.providerListSkillsCatalog, input),
      listPlugins: (input) => transport.request(WS_METHODS.providerListPlugins, input),
      readPlugin: (input) => transport.request(WS_METHODS.providerReadPlugin, input),
      listModels: (input) => transport.request(WS_METHODS.providerListModels, input),
      listAgents: (input) => transport.request(WS_METHODS.providerListAgents, input),
    },
    orchestration: {
      getSnapshot: () => transport.request(ORCHESTRATION_WS_METHODS.getSnapshot),
      getShellSnapshot: () => transport.request(ORCHESTRATION_WS_METHODS.getShellSnapshot),
      getThreadDetailSnapshot: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot, input),
      dispatchCommand: (command) => {
        return transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
          command: omitNullUserInputAnswers(command),
        });
      },
      importThread: (input) => transport.request(ORCHESTRATION_WS_METHODS.importThread, input),
      repairState: () => transport.request(ORCHESTRATION_WS_METHODS.repairState),
      getTurnDiff: (input) => transport.request(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      replayEvents: (fromSequenceExclusive) =>
        transport.request(ORCHESTRATION_WS_METHODS.replayEvents, {
          fromSequenceExclusive,
        }),
      listProviderDeliveryBlockers: (input = {}) =>
        transport.request(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers, input),
      reconcileProviderDelivery: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery, input),
      subscribeShell: () => transport.request<void>(ORCHESTRATION_WS_METHODS.subscribeShell, {}),
      unsubscribeShell: () =>
        transport.request<void>(ORCHESTRATION_WS_METHODS.unsubscribeShell, {}),
      subscribeThread: (input) =>
        transport.request<void>(ORCHESTRATION_WS_METHODS.subscribeThread, input),
      unsubscribeThread: (input) =>
        transport.request<void>(ORCHESTRATION_WS_METHODS.unsubscribeThread, input),
      onDomainEvent: (callback) => {
        const shouldStartTransport = orchestrationDomainEventListeners.size === 0;
        const unsubscribe = orchestrationDomainEventListeners.subscribe(callback);
        if (shouldStartTransport) {
          unsubscribeDomainEventTransport = transport.subscribe(
            ORCHESTRATION_WS_CHANNELS.domainEvent,
            (message) => orchestrationDomainEventListeners.emit(message.data),
          );
        }
        return () => {
          unsubscribe();
          if (orchestrationDomainEventListeners.size === 0) {
            unsubscribeDomainEventTransport?.();
            unsubscribeDomainEventTransport = null;
          }
        };
      },
      onShellEvent: orchestrationShellEventListeners.subscribe,
      onThreadEvent: orchestrationThreadEventListeners.subscribe,
    },
    automation: {
      list: (input) => transport.request(WS_METHODS.automationList, input),
      getMemory: (input) => transport.request(WS_METHODS.automationGetMemory, input),
      create: (input) => transport.request(WS_METHODS.automationCreate, input),
      update: (input) => transport.request(WS_METHODS.automationUpdate, input),
      delete: (input) => transport.request(WS_METHODS.automationDelete, input),
      runNow: (input) => transport.request(WS_METHODS.automationRunNow, input),
      cancelRun: (input) => transport.request(WS_METHODS.automationCancelRun, input),
      markRunRead: (input) => transport.request(WS_METHODS.automationMarkRunRead, input),
      archiveRun: (input) => transport.request(WS_METHODS.automationArchiveRun, input),
      resolveProposal: (input) => transport.request(WS_METHODS.automationResolveProposal, input),
      onEvent: automationEventListeners.subscribe,
    },
    browser: {
      open: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.open(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        if (input.initialUrl && state.tabs.length > 0) {
          const activeTab = resolveFallbackBrowserTab(state);
          activeTab.url = input.initialUrl;
          activeTab.title = defaultBrowserTitle(input.initialUrl);
          activeTab.lastCommittedUrl = input.initialUrl;
        }
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      close: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.close(input);
        }
        const state = getFallbackBrowserState(input.threadId);
        state.open = false;
        state.activeTabId = null;
        state.tabs = [];
        state.lastError = null;
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      hide: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.hide(input);
        }
      },
      getState: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.getState(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      setPanelBounds: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.setPanelBounds(input);
          return;
        }
      },
      attachWebview: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.attachWebview(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      detachWebview: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.detachWebview(input);
        }
      },
      copyLink: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.copyLink(input);
          return;
        }
        throw new Error("Copying the browser link requires the desktop app.");
      },
      copyScreenshotToClipboard: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.copyScreenshotToClipboard(input);
          return;
        }
        throw new Error("Browser screenshots require the desktop app.");
      },
      captureScreenshot: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.captureScreenshot(input);
        }
        throw new Error("Browser screenshots require the desktop app.");
      },
      executeCdp: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.executeCdp(input);
        }
        throw new Error("Browser automation requires the desktop app.");
      },
      navigate: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.navigate(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = resolveFallbackBrowserTab(state, input.tabId);
        tab.url = input.url;
        tab.title = defaultBrowserTitle(input.url);
        tab.lastCommittedUrl = input.url;
        tab.lastError = null;
        tab.status = "live";
        state.activeTabId = tab.id;
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      reload: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.reload(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      goBack: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.goBack(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      goForward: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.goForward(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      newTab: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.newTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = createFallbackTab(input.url);
        state.tabs = [...state.tabs, tab];
        if (input.activate !== false || !state.activeTabId) {
          state.activeTabId = tab.id;
        }
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      closeTab: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.closeTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
        if (nextTabs.length === state.tabs.length) {
          return cloneBrowserState(state);
        }
        state.tabs = nextTabs;
        if (nextTabs.length === 0) {
          const replacementTab = createFallbackTab();
          state.tabs = [replacementTab];
          state.activeTabId = replacementTab.id;
          state.lastError = null;
        } else if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0]?.id ?? null;
        }
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      selectTab: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.selectTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = resolveFallbackBrowserTab(state, input.tabId);
        state.activeTabId = tab.id;
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      openDevTools: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.openDevTools(input);
        }
      },
      onState: (callback) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.onState(callback);
        }
        return fallbackBrowserStateListeners.subscribe(callback);
      },
      onCopyLink: (callback) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.onBrowserCopyLink(callback);
        }
        return () => {};
      },
    },
  };

  instance = { api, transport };
  return api;
}

// Browser-mode tests mount full app roots repeatedly in one page; reset the
// singleton so each test gets a fresh WebSocket stream and cached push state.
export async function resetWsNativeApiForTest(): Promise<void> {
  const transport = instance?.transport;
  instance = null;
  clearWsNativeApiListeners();
  fallbackBrowserStates.clear();
  await transport?.dispose();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void instance?.transport.dispose();
    instance = null;
    clearWsNativeApiListeners();
  });
}

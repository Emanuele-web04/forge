import "../index.css";

import {
  DEVICE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_METHODS,
} from "@synara/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws, http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
  type EffectRpcWebSocketClient,
} from "../test/effectRpcWebSocketMock";
import { createBrowserTestServerConfig, createFullscreenTestHost } from "../test/browserHarness";
import { resetWsNativeApiForTest } from "../wsNativeApi";

const THREAD_ID = "thread-kb-toast-test" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
let serverConfigStreamClient: EffectRpcWebSocketClient | null = null;
let serverConfigStreamRequestId: string | null = null;
// Subscription budget stays generous: slow CI still needs tens of seconds for
// WS sequencing after a cold start. Route-chunk warming happens in beforeAll
// below, so this is a backstop, not the cold path.
const COLD_MOUNT_SUBSCRIPTION_TIMEOUT_MS = 60_000;
const SUBSCRIPTION_POLL_INTERVAL_MS = 16;
// Warmup budget: absorbs the bulk of a cold chunk transform so the real
// mounts start warm. Sized under the 90s hook budget with room for worker
// start and the interception probe.
const WARMUP_MOUNT_SUBSCRIPTION_TIMEOUT_MS = 80_000;

const wsLink = ws.link(/ws(s)?:\/\/.*/);

// The mock Service Worker activates asynchronously after worker.start()
// resolves. A WebSocket opened before activation bypasses the mock, so the
// first mount's subscribeServerConfig request never arrives and no wait
// budget can save it. Probing a dummy socket proves the interception path is
// live before any mount. Full runs hide this because an earlier file warms
// the origin's registration; a shard can run this file cold.
const WS_INTERCEPTION_PROBE_PATH = "/__mock-interception-probe";
const WS_MOCK_ACTIVATION_TIMEOUT_MS = 30_000;
const WS_PROBE_SETTLE_MS = 1_000;
const WS_PROBE_RETRY_INTERVAL_MS = 250;

function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}

function createMinimalSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Test thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [
          {
            id: "msg-1" as MessageId,
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(): TestFixture {
  return {
    snapshot: createMinimalSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function getThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Missing thread fixture for ${threadId}`);
  }
  return thread;
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = flattenEffectRpcRequestPayload(
        parsed.request.tag,
        parsed.request.payload,
      );
      const method = requestBody._tag;
      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        serverConfigStreamClient = client;
        serverConfigStreamRequestId = parsed.request.id;
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread: getThreadDetailFromFixtureSnapshot(threadId),
          },
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents ||
        // Left open like the rest: these are infinite subscriptions, and the
        // default below answers with an Exit, which a stream RPC reads as the
        // socket dying and answers with a full reconnect. That loops forever
        // and fills the run with schema errors about an Exit whose Success
        // value is `{}` where Void was expected.
        method === DEVICE_WS_METHODS.subscribeEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(method));
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function sendServerConfigUpdatedPush(
  issues: Array<{ kind: string; message: string }>,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(serverConfigStreamRequestId).toBeTruthy();
      expect(serverConfigStreamClient).toBeTruthy();
    },
    { timeout: 4_000, interval: 16 },
  );
  if (!serverConfigStreamRequestId || !serverConfigStreamClient) return;
  sendEffectRpcChunk(serverConfigStreamClient, serverConfigStreamRequestId, {
    type: "configUpdated",
    payload: {
      issues,
      providers: fixture.serverConfig.providers,
    },
  });
}

async function probeWsMockInterception(): Promise<boolean> {
  const socket = new WebSocket(`ws://${window.location.host}${WS_INTERCEPTION_PROBE_PATH}`);
  try {
    await vi.waitFor(
      () => {
        expect(wsLink.clients.size).toBeGreaterThan(0);
      },
      { timeout: WS_PROBE_SETTLE_MS, interval: SUBSCRIPTION_POLL_INTERVAL_MS },
    );
    return true;
  } catch {
    // The probe bypassed the mock: activation is still in flight. The caller
    // retries until the activation budget runs out, then fails loudly.
    return false;
  } finally {
    socket.close();
  }
}

async function waitForWsMockInterception(): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await probeWsMockInterception()).toBe(true);
    },
    { timeout: WS_MOCK_ACTIVATION_TIMEOUT_MS, interval: WS_PROBE_RETRY_INTERVAL_MS },
  );
}

function queryToastTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="toast-title"]')).map(
    (el) => el.textContent ?? "",
  );
}

async function waitForToast(title: string, count = 1): Promise<void> {
  await vi.waitFor(
    () => {
      const matches = queryToastTitles().filter((t) => t === title);
      expect(matches.length, `Expected ${count} "${title}" toast(s)`).toBeGreaterThanOrEqual(count);
    },
    { timeout: 4_000, interval: 16 },
  );
}

async function waitForNoToast(title: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(queryToastTitles().filter((t) => t === title)).toHaveLength(0);
    },
    { timeout: 10_000, interval: 50 },
  );
}

async function mountApp(
  subscriptionTimeoutMs = COLD_MOUNT_SUBSCRIPTION_TIMEOUT_MS,
): Promise<{ cleanup: () => Promise<void> }> {
  const host = createFullscreenTestHost();

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_ID}`] }));

  const screen = await render(<RouterProvider router={router} />, { container: host });
  try {
    await vi.waitFor(
      () => {
        expect(serverConfigStreamRequestId).toBeTruthy();
        expect(serverConfigStreamClient).toBeTruthy();
      },
      // Generous backstop for slow CI; chunk warming happens in beforeAll.
      { timeout: subscriptionTimeoutMs, interval: SUBSCRIPTION_POLL_INTERVAL_MS },
    );
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }
  let cleanedUp = false;

  return {
    cleanup: async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await screen.unmount();
      if (host.isConnected) host.remove();
    },
  };
}

// beforeAll worst case (30s activation + 80s warmup + worker start) exceeds the
// 90s hookTimeout in vitest.browser.config.ts, so raise it for this file.
vi.setConfig({ hookTimeout: 150_000 });

describe("Keybindings update toast", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
    await waitForWsMockInterception();
    // Warm the code-split thread route before any test mounts. On a cold dev
    // cache the first mount suspends on chunk transform; warming it here pays
    // that cost once in the hook budget instead of failing the first test.
    // Full runs hide this because an earlier file warms the cache; a shard
    // can run this file cold. The warmup mount shows no toasts (clean mount,
    // no pushes) and beforeEach resets all module state, so it cannot leak
    // into assertions. A warmup timeout is deliberately ignored: the chunks
    // it did fetch stay cached, and a still-cold mount fails loudly below.
    try {
      const warmup = await mountApp(WARMUP_MOUNT_SUBSCRIPTION_TIMEOUT_MS);
      await warmup.cleanup();
    } catch {
      // Deliberate ignore, reason above; still-cold mounts fail loudly below.
    }
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    localStorage.clear();
    document.body.innerHTML = "";
    serverConfigStreamClient = null;
    serverConfigStreamRequestId = null;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not show success toasts for passive keybinding reloads", async () => {
    const mounted = await mountApp();

    try {
      await sendServerConfigUpdatedPush([]);
      await waitForNoToast("Keybindings updated");

      await sendServerConfigUpdatedPush([]);
      await waitForNoToast("Keybindings updated");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a warning toast when keybinding config has issues", async () => {
    const mounted = await mountApp();

    try {
      await sendServerConfigUpdatedPush([
        { kind: "keybindings.malformed-config", message: "Expected JSON array" },
      ]);
      await waitForToast("Invalid keybindings configuration");
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show a toast from the replayed cached value on subscribe", async () => {
    const mounted = await mountApp();

    try {
      await sendServerConfigUpdatedPush([]);
      await waitForNoToast("Keybindings updated");

      // Remount the app — onServerConfigUpdated replays the cached value
      // synchronously on subscribe. This should NOT produce a toast.
      await mounted.cleanup();
      const remounted = await mountApp();

      // Give it a moment to process the replayed value
      await new Promise((resolve) => setTimeout(resolve, 500));

      const titles = queryToastTitles();
      expect(
        titles.filter((t) => t === "Keybindings updated").length,
        "Replayed cached value should not produce a toast",
      ).toBe(0);

      await remounted.cleanup();
    } catch (error) {
      await mounted.cleanup().catch(() => {});
      throw error;
    }
  });
});

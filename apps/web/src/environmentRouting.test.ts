// FILE: environmentRouting.test.ts
// Purpose: Proves a remote thread's mutations and uploads reach the REMOTE host,
//          never the local server, and that an unreachable host refuses loudly.
// Layer: Web transport routing tests
//
// Ownership here is POSITIONAL, matching the store: a thread belongs to the
// environment whose record holds it. Fixtures therefore place a thread shell or
// a project INSIDE an environment record rather than setting a side table, so a
// test cannot assert an ownership arrangement the real store cannot represent.

import { EnvironmentId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const REMOTE_WS_URL = "wss://vps.example.com/ws?token=remote-token";
const REMOTE_THREAD_ID = ThreadId.makeUnsafe("thread-remote");
const LOCAL_THREAD_ID = ThreadId.makeUnsafe("thread-local");

interface FakeClient {
  readonly environmentId: EnvironmentId;
  readonly wsUrl: string | null;
  readonly api: Record<string, unknown>;
}

const registeredClients = new Map<EnvironmentId, FakeClient>();
const localDispatch = vi.fn(async () => ({ sequence: 1 }));
const remoteDispatch = vi.fn(async () => ({ sequence: 1 }));
const localSubscribeThread = vi.fn(async () => undefined);
const remoteSubscribeThread = vi.fn(async () => undefined);
const localGetSnapshot = vi.fn(async () => ({ threads: [] }));

/**
 * Non-routed members that live on a group the router DOES wrap, mirroring the
 * real contract: `terminal.onEvent` sits beside 7 routed terminal methods, and
 * `git.status` beside the single routed `git.handoffThread`.
 *
 * They exist so a test can prove the wrapper carries a group's other members
 * across untouched. `terminal.onEvent` in particular is the subscription every
 * terminal's output depends on.
 */
const NON_ROUTED_SIBLINGS: Readonly<Record<string, readonly string[]>> = {
  terminal: ["onEvent"],
  git: ["status", "onActionProgress"],
};

/**
 * A fake NativeApi covering every group the router touches.
 *
 * Built from `ROUTED_METHODS` so that a method added to the routing table is
 * automatically present on both fakes; a test for it then compares two real
 * spies rather than silently exercising `undefined`.
 */
function makeApi(
  dispatch: typeof localDispatch,
  subscribeThread: typeof localSubscribeThread,
): Record<string, unknown> {
  const api: Record<string, Record<string, unknown>> = {};
  for (const [group, methods] of Object.entries(ROUTED_METHODS)) {
    const groupApi: Record<string, unknown> = {};
    for (const method of methods as readonly string[]) {
      groupApi[method] = vi.fn(async () => ({}));
    }
    for (const sibling of NON_ROUTED_SIBLINGS[group] ?? []) {
      groupApi[sibling] = vi.fn(() => vi.fn());
    }
    api[group] = groupApi;
  }
  api.orchestration = {
    ...api.orchestration,
    dispatchCommand: dispatch,
    subscribeThread,
    getSnapshot: localGetSnapshot,
    getShellSnapshot: vi.fn(async () => ({})),
    repairState: vi.fn(async () => ({})),
  };
  return api;
}

/** The spy a fake API installed for `group.method`. */
function spyFor(client: FakeClient, group: string, method: string) {
  return (client.api[group] as Record<string, ReturnType<typeof vi.fn>>)[method];
}

const localClient: FakeClient = {
  environmentId: LOCAL_ENVIRONMENT_ID,
  wsUrl: null,
  api: makeApi(localDispatch, localSubscribeThread),
};
const remoteClient: FakeClient = {
  environmentId: REMOTE_ENVIRONMENT_ID,
  wsUrl: REMOTE_WS_URL,
  api: makeApi(remoteDispatch, remoteSubscribeThread),
};

vi.mock("./wsEnvironmentRegistry", () => ({
  localWsEnvironmentClient: () => localClient,
  getWsEnvironmentClient: (environmentId: EnvironmentId) => registeredClients.get(environmentId),
}));

/**
 * A minimal `environmentById` store, shaped like the real one.
 *
 * `ownThread`/`ownProject` are the only way a test states ownership, because
 * that is the only way the store can: there is no field to set, just a record
 * that holds the row.
 */
const storeState: { environmentById: Record<string, Record<string, unknown>> } = {
  environmentById: {},
};

function emptyEnvironment(): Record<string, unknown> {
  return { threadShellById: {}, projects: [], threadsHydrated: true, spaces: [] };
}

function environmentRecord(environmentId: string): Record<string, unknown> {
  storeState.environmentById[environmentId] ??= emptyEnvironment();
  return storeState.environmentById[environmentId]!;
}

/** Places a thread shell in an environment's record — the store's only ownership. */
function ownThread(environmentId: string, threadId: ThreadId): void {
  const record = environmentRecord(environmentId);
  (record.threadShellById as Record<string, unknown>)[threadId] = { id: threadId };
}

/** Places a project in an environment's record. */
function ownProject(environmentId: string, projectId: string): void {
  const record = environmentRecord(environmentId);
  (record.projects as unknown[]).push({ id: projectId });
}

vi.mock("./store", () => ({
  useStore: { getState: () => storeState },
}));

import {
  createEnvironmentRoutedApi,
  LOCAL_ONLY_THREAD_METHODS,
  ROUTED_METHODS,
} from "./environmentRoutedApi";
import {
  claimThreadEnvironment,
  EnvironmentUnavailableError,
  resetThreadEnvironmentClaims,
  resolveThreadEnvironmentId,
  resolveThreadHttpUrl,
} from "./environmentRouting";

beforeEach(() => {
  registeredClients.clear();
  registeredClients.set(LOCAL_ENVIRONMENT_ID, localClient);
  storeState.environmentById = { [LOCAL_ENVIRONMENT_ID]: emptyEnvironment() };
  resetThreadEnvironmentClaims();
  vi.clearAllMocks();
});

afterEach(() => {
  resetThreadEnvironmentClaims();
});

describe("thread ownership resolution", () => {
  it("defaults to local for a thread no environment has claimed", () => {
    expect(resolveThreadEnvironmentId(LOCAL_THREAD_ID)).toBe(LOCAL_ENVIRONMENT_ID);
  });

  it("resolves the reporting environment for a thread a remote snapshot claimed", () => {
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("uses a composer claim for a thread no snapshot has reported yet", () => {
    // A brand-new remote thread exists nowhere until `thread.create` lands, so
    // without the claim the very first dispatch of the very first remote thread
    // would go to the local server.
    claimThreadEnvironment(REMOTE_THREAD_ID, REMOTE_ENVIRONMENT_ID);
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("lets a server report override a stale claim", () => {
    claimThreadEnvironment(REMOTE_THREAD_ID, REMOTE_ENVIRONMENT_ID);
    ownThread(LOCAL_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(LOCAL_ENVIRONMENT_ID);
  });

  it("resolves a colliding thread id to the first owner in aggregate order", () => {
    // Two servers can hold the same server-issued id (a clone, or a restore
    // from another server's backup). The aggregate view renders the FIRST
    // owner's row, so routing has to pick the same one or the user acts on a
    // row belonging to a different machine than the one they are looking at.
    ownThread(LOCAL_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(LOCAL_ENVIRONMENT_ID);
  });
});

describe("environment-routed orchestration dispatch", () => {
  it("sends a remote thread's mutation to the remote host, not the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: "command-1",
      threadId: REMOTE_THREAD_ID,
      createdAt: "2026-07-28T00:00:00.000Z",
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("keeps a local thread's mutation on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: "command-1",
      threadId: LOCAL_THREAD_ID,
      createdAt: "2026-07-28T00:00:00.000Z",
    } as never);

    expect(localDispatch).toHaveBeenCalledTimes(1);
    expect(remoteDispatch).not.toHaveBeenCalled();
  });

  it("routes thread subscribe to the owning host", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.subscribeThread({ threadId: REMOTE_THREAD_ID } as never);
    expect(remoteSubscribeThread).toHaveBeenCalledTimes(1);
    expect(localSubscribeThread).not.toHaveBeenCalled();
  });

  it("refuses rather than silently falling back when the owning host is disconnected", async () => {
    // No remote client registered: the environment is known but not connected.
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    const api = createEnvironmentRoutedApi(localClient.api as never);

    await expect(
      api.orchestration.dispatchCommand({
        type: "thread.session.stop",
        commandId: "command-1",
        threadId: REMOTE_THREAD_ID,
        createdAt: "2026-07-28T00:00:00.000Z",
      } as never),
    ).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("leaves server-wide orchestration calls on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.getSnapshot();
    expect(localGetSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe("every routed method reaches the owning host", () => {
  /**
   * Drives EVERY entry in the routing table, not a hand-picked few.
   *
   * Exhaustiveness of the table itself is enforced against the contract at
   * type-check time (`environmentRoutingCoverage.test-d.ts`). This proves the
   * table is also OBEYED: a method listed but wired wrong — the group spread
   * dropping it, say — fails here rather than shipping.
   */
  for (const [group, methods] of Object.entries(ROUTED_METHODS)) {
    for (const method of methods as readonly string[]) {
      it(`routes ${group}.${method} to the remote host`, async () => {
        registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
        ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

        const api = createEnvironmentRoutedApi(localClient.api as never);
        const routedGroup = (api as unknown as Record<string, Record<string, unknown>>)[group];
        const callable = routedGroup?.[method] as (input: unknown) => Promise<unknown>;
        await callable({ threadId: REMOTE_THREAD_ID });

        expect(spyFor(remoteClient, group, method)).toHaveBeenCalledTimes(1);
        expect(spyFor(localClient, group, method)).not.toHaveBeenCalled();
      });
    }
  }
});

describe("thread-scoped methods outside orchestration", () => {
  it("writes a remote thread's terminal input to the remote host, not the laptop", async () => {
    // Unrouted, a user who opens a terminal in a remote thread and types a
    // deploy command runs it on their own machine.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.terminal.write({ threadId: REMOTE_THREAD_ID, data: "deploy\n" } as never);

    expect(spyFor(remoteClient, "terminal", "write")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "terminal", "write")).not.toHaveBeenCalled();
  });

  it("runs a remote thread's git handoff against the remote checkout", async () => {
    // GitHandoffThreadInput carries both threadId and cwd, and a cwd that
    // exists on both machines makes a misroute a silent success on the wrong
    // working tree rather than an error.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.git.handoffThread({
      threadId: REMOTE_THREAD_ID,
      cwd: "/Users/dylan/dev/foo",
    } as never);

    expect(spyFor(remoteClient, "git", "handoffThread")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "git", "handoffThread")).not.toHaveBeenCalled();
  });

  it("keeps a local thread's terminal input on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.terminal.write({ threadId: LOCAL_THREAD_ID, data: "ls\n" } as never);

    expect(spyFor(localClient, "terminal", "write")).toHaveBeenCalledTimes(1);
    expect(spyFor(remoteClient, "terminal", "write")).not.toHaveBeenCalled();
  });

  it("refuses a terminal write when the owning host is disconnected", async () => {
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    const api = createEnvironmentRoutedApi(localClient.api as never);

    await expect(
      api.terminal.write({ threadId: REMOTE_THREAD_ID, data: "deploy\n" } as never),
    ).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    expect(spyFor(localClient, "terminal", "write")).not.toHaveBeenCalled();
  });
});

describe("project-scoped commands", () => {
  it("applies a remote project's mutation on the remote host", async () => {
    // `project.meta.update` carries only projectId. Falling back to local here
    // renames the LOCAL server's copy while the UI badge says the remote host.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownProject(REMOTE_ENVIRONMENT_ID, "project-remote");

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: "command-1",
      projectId: "project-remote",
      isPinned: true,
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("routes a space assignment by the projects it moves", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownProject(REMOTE_ENVIRONMENT_ID, "project-remote");

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "space.projects.assign",
      commandId: "command-1",
      spaceId: "space-1",
      projectIds: ["project-remote"],
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("creates a new thread in a remote project on that project's host, with no claim", async () => {
    // `thread.create` carries a brand-new threadId no snapshot has reported,
    // ALONGSIDE the projectId that does identify a host. Resolving the unknown
    // thread straight to local would create a remote project's thread on the
    // laptop whenever the composer claim is missing or already released —
    // making the claim the only thing preventing it, rather than a shortcut.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownProject(REMOTE_ENVIRONMENT_ID, "project-remote");

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: "command-1",
      threadId: "thread-brand-new",
      projectId: "project-remote",
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("lets a thread's own reported owner outrank its project's", async () => {
    // A thread moved between hosts, or a project whose ownership is stale: the
    // thread's own reported owner is the more specific fact and must win.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(LOCAL_ENVIRONMENT_ID, LOCAL_THREAD_ID);
    ownProject(REMOTE_ENVIRONMENT_ID, "project-remote");

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: "command-1",
      threadId: LOCAL_THREAD_ID,
      projectId: "project-remote",
    } as never);

    expect(localDispatch).toHaveBeenCalledTimes(1);
    expect(remoteDispatch).not.toHaveBeenCalled();
  });

  it("keeps a local project's mutation on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: "command-1",
      projectId: "project-local",
      isPinned: true,
    } as never);

    expect(localDispatch).toHaveBeenCalledTimes(1);
    expect(remoteDispatch).not.toHaveBeenCalled();
  });
});

describe("non-routed members of a routed group", () => {
  /**
   * The wrapper rebuilds each routed group from a spread. Anything it fails to
   * carry across becomes `undefined` on the returned API.
   *
   * `terminal` is the sharp case: 7 of its 8 methods are wrapped, and the 8th,
   * `onEvent`, is the subscription every terminal's output depends on. Drop it
   * and a terminal opens, accepts input, and shows nothing — plausible-looking
   * and very hard to trace back to routing. Until now this was covered only
   * incidentally by the app working, which is the coverage that disappears the
   * moment someone refactors the wrapper.
   */
  it("carries them across with identity preserved", () => {
    const api = createEnvironmentRoutedApi(localClient.api as never);
    const routed = api as unknown as Record<string, Record<string, unknown>>;
    const original = localClient.api as Record<string, Record<string, unknown>>;

    for (const [group, siblings] of Object.entries(NON_ROUTED_SIBLINGS)) {
      for (const sibling of siblings) {
        // Identity, not just presence: a re-wrapped listener would still be a
        // function while silently no longer being the registry's own.
        expect(routed[group]?.[sibling]).toBe(original[group]?.[sibling]);
      }
    }
  });

  it("keeps a subscription live, returning a working unsubscribe", () => {
    // The nastier variant of the same failure: a subscription that appears to
    // register but hands back a dead unsubscribe leaks listeners and never
    // reports an error.
    const api = createEnvironmentRoutedApi(localClient.api as never);
    const listener = vi.fn();

    const unsubscribe = api.terminal.onEvent(listener);

    expect(spyFor(localClient, "terminal", "onEvent")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "terminal", "onEvent")).toHaveBeenCalledWith(listener);
    expect(typeof unsubscribe).toBe("function");
  });

  it("still routes the wrapped methods on that same group", () => {
    // Guards the reverse mistake: "preserve the siblings" must not become
    // "preserve the whole group" and quietly un-route terminal.write.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    const api = createEnvironmentRoutedApi(localClient.api as never);

    expect(api.terminal.write).not.toBe(
      (localClient.api as Record<string, Record<string, unknown>>).terminal?.write,
    );
  });
});

describe("the routing decision tables", () => {
  it("leaves the server-wide orchestration methods unrouted", () => {
    for (const method of ["getSnapshot", "getShellSnapshot", "repairState", "replayEvents"]) {
      expect(ROUTED_METHODS.orchestration as readonly string[]).not.toContain(method);
    }
  });

  it("keeps the embedded browser on the user's own machine", () => {
    // The webview is a panel in the user's window, not a resource on the
    // thread's host; a headless VPS has no display to drive.
    expect(Object.keys(ROUTED_METHODS)).not.toContain("browser");
    expect(LOCAL_ONLY_THREAD_METHODS.browser).toContain("navigate");
  });

  it("documents that cwd-keyed calls are NOT routed by this module", () => {
    // Pins the boundary of THIS module: a bare `cwd` carries no host identity,
    // so the thread/project key cannot answer for it. These are routed
    // separately by the path-ownership resolver rather than here; asserting it
    // keeps a future contributor from "fixing" the omission by adding them to
    // a table that cannot resolve them.
    for (const method of ["checkout", "status", "createWorktree", "stageFiles", "pull"]) {
      expect(ROUTED_METHODS.git as readonly string[]).not.toContain(method);
    }
    // The one cwd-family method resolvable here, because it also carries threadId.
    expect(ROUTED_METHODS.git as readonly string[]).toContain("handoffThread");
    expect(Object.keys(ROUTED_METHODS)).not.toContain("projects");
    expect(Object.keys(ROUTED_METHODS)).not.toContain("filesystem");
  });
});

describe("HTTP-backed route resolution", () => {
  it("resolves a remote thread's upload against the remote host's origin", () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    const url = new URL(resolveThreadHttpUrl(REMOTE_THREAD_ID, "/api/attachments/upload"));
    expect(url.origin).toBe("https://vps.example.com");
    expect(url.pathname).toBe("/api/attachments/upload");
    // The remote environment's own credential rides along; the local one's must not.
    expect(url.searchParams.get("token")).toBe("remote-token");
  });

  it("refuses to resolve an upload for a disconnected remote host", () => {
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    expect(() => resolveThreadHttpUrl(REMOTE_THREAD_ID, "/api/attachments/upload")).toThrow(
      EnvironmentUnavailableError,
    );
  });
});

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
 * `git.onActionProgress` beside git's routed ones.
 *
 * They exist so a test can prove the wrapper carries a group's other members
 * across untouched. `terminal.onEvent` in particular is the subscription every
 * terminal's output depends on.
 *
 * `git.status` used to be listed here and is NOT any more: it is `cwd`-keyed,
 * so path routing now sends it to the host that owns the checkout. Both
 * remaining entries are event subscriptions, which is the honest shape — a
 * subscription is a listener on this client, not a call about a resource.
 */
const NON_ROUTED_SIBLINGS: Readonly<Record<string, readonly string[]>> = {
  terminal: ["onEvent"],
  git: ["onActionProgress"],
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
  // Both tables, merged per group: `git` appears in each (handoffThread is
  // id-routed, checkout and friends are path-routed), so a per-group reset here
  // would silently leave one set as `undefined` and its tests exercising
  // nothing.
  const tables = [ROUTED_METHODS, CWD_ROUTED_METHODS] as ReadonlyArray<
    Readonly<Record<string, readonly string[]>>
  >;
  for (const table of tables) {
    for (const [group, methods] of Object.entries(table)) {
      const groupApi: Record<string, unknown> = { ...api[group] };
      for (const method of methods) {
        groupApi[method] = vi.fn(async () => ({}));
      }
      for (const sibling of NON_ROUTED_SIBLINGS[group] ?? []) {
        groupApi[sibling] = vi.fn(() => vi.fn());
      }
      api[group] = groupApi;
    }
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
function ownProject(environmentId: string, projectId: string, cwd?: string): void {
  const record = environmentRecord(environmentId);
  (record.projects as unknown[]).push({ id: projectId, ...(cwd ? { cwd } : {}) });
}

vi.mock("./store", () => ({
  useStore: { getState: () => storeState },
}));

import {
  createEnvironmentRoutedApi,
  CWD_ROUTED_METHODS,
  LOCAL_ONLY_THREAD_METHODS,
  ROUTED_METHODS,
} from "./environmentRoutedApi";
import { UnknownPathEnvironmentError } from "./environmentPathRouting";
import { stageUploadComposerAttachments } from "./lib/composerSend";
import {
  claimThreadEnvironment,
  EnvironmentUnavailableError,
  resetThreadEnvironmentClaims,
  resolveThreadEnvironmentId,
  resolveThreadHttpUrl,
  threadResumeCursors,
} from "./environmentRouting";
import {
  resetThreadDetailResumeCursorsForTests,
  threadDetailResumeCursors,
} from "./threadDetailResumeCursors";

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

describe("resume cursors are filed under the owning environment", () => {
  beforeEach(() => {
    resetThreadDetailResumeCursorsForTests();
  });

  it("records a remote thread's sequence in that environment's space, not local", () => {
    // Sequences are per-server autoincrement values. Filing a remote thread's
    // cursor locally both loses the real cursor AND poisons the local space
    // with a number from another journal — a later local resume would then
    // skip every event below it.
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    threadResumeCursors(REMOTE_THREAD_ID).advance(REMOTE_THREAD_ID, 42);

    expect(threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID).get(REMOTE_THREAD_ID)).toBe(42);
    expect(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).get(REMOTE_THREAD_ID)).toBeUndefined();
  });

  it("keeps a local thread's cursor local", () => {
    ownThread(LOCAL_ENVIRONMENT_ID, LOCAL_THREAD_ID);

    threadResumeCursors(LOCAL_THREAD_ID).advance(LOCAL_THREAD_ID, 7);

    expect(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).get(LOCAL_THREAD_ID)).toBe(7);
  });

  it("lets two hosts hold the same sequence for the same thread id independently", () => {
    // Two servers both starting at sequence 1 is the normal case. A shared
    // cursor space would let one server's number fence the other's stream.
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    threadResumeCursors(REMOTE_THREAD_ID).advance(REMOTE_THREAD_ID, 5);
    threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).advance(REMOTE_THREAD_ID, 99);

    expect(threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID).get(REMOTE_THREAD_ID)).toBe(5);
    expect(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).get(REMOTE_THREAD_ID)).toBe(99);
  });
});

describe("cwd-keyed calls route by path ownership", () => {
  const LOCAL_CWD = "/Users/me/dev/laptop-app";
  const REMOTE_CWD = "/srv/vps-service";

  function ownPaths(): void {
    ownProject(LOCAL_ENVIRONMENT_ID, "project-local", LOCAL_CWD);
    ownProject(REMOTE_ENVIRONMENT_ID, "project-remote", REMOTE_CWD);
  }

  it("runs git.checkout against the checkout whose host owns that path", async () => {
    // The failure this closes: unrouted, this ran on the LOCAL machine, and
    // because the same path plausibly exists on both it succeeded — against the
    // wrong working tree.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownPaths();

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.git.checkout({ cwd: `${REMOTE_CWD}/src`, ref: "main" } as never);

    expect(spyFor(remoteClient, "git", "checkout")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "git", "checkout")).not.toHaveBeenCalled();
  });

  it("keeps a local path's write on the local machine", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownPaths();

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.projects.writeFile({ cwd: LOCAL_CWD, path: "a.ts", content: "" } as never);

    expect(spyFor(localClient, "projects", "writeFile")).toHaveBeenCalledTimes(1);
    expect(spyFor(remoteClient, "projects", "writeFile")).not.toHaveBeenCalled();
  });

  it("REFUSES an unowned path once a remote host exists, running it nowhere", async () => {
    // Fail-closed: a silent write to the wrong checkout is unrecoverable, a
    // refusal costs a click. Crucially it does NOT fall through to local.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownPaths();

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await expect(
      api.projects.writeFile({ cwd: "/tmp/scratch", path: "a.ts", content: "" } as never),
    ).rejects.toBeInstanceOf(UnknownPathEnvironmentError);

    expect(spyFor(localClient, "projects", "writeFile")).not.toHaveBeenCalled();
    expect(spyFor(remoteClient, "projects", "writeFile")).not.toHaveBeenCalled();
  });

  it("runs an unowned path locally when NO remote host is registered", async () => {
    // A local-only install must behave exactly as it does today: no migration,
    // no new refusals, nothing to click.
    ownProject(LOCAL_ENVIRONMENT_ID, "project-local", LOCAL_CWD);

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.projects.writeFile({ cwd: "/tmp/scratch", path: "a.ts", content: "" } as never);

    expect(spyFor(localClient, "projects", "writeFile")).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than running locally when the owning host is disconnected", async () => {
    // The host is known but not connected. Falling back to local would run a
    // remote checkout's git command on the laptop.
    ownPaths();

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await expect(api.git.status({ cwd: REMOTE_CWD } as never)).rejects.toBeInstanceOf(
      EnvironmentUnavailableError,
    );
    expect(spyFor(localClient, "git", "status")).not.toHaveBeenCalled();
  });

  it("routes by the owning environment even when both hosts are the same machine", async () => {
    // The `ssh localhost` shape. A resolver that stat'd the filesystem or
    // compared hostnames would look correct here and fail on a real VPS, so
    // this pins that ownership comes from the store record alone.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownProject(LOCAL_ENVIRONMENT_ID, "project-local", "/Users/me/dev/app");
    ownProject(REMOTE_ENVIRONMENT_ID, "project-remote", "/Users/me/dev/app/service");

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.git.status({ cwd: "/Users/me/dev/app/service/src" } as never);

    expect(spyFor(remoteClient, "git", "status")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "git", "status")).not.toHaveBeenCalled();
  });

  it("still routes git.handoffThread by its threadId, not its cwd", async () => {
    // It carries both keys. The id is the more specific one, and routing it
    // twice could disagree with itself — the type-level check forbids listing
    // it in both tables, and this proves the runtime honours the id.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);
    ownProject(LOCAL_ENVIRONMENT_ID, "project-local", LOCAL_CWD);

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.git.handoffThread({ threadId: REMOTE_THREAD_ID, cwd: LOCAL_CWD } as never);

    expect(spyFor(remoteClient, "git", "handoffThread")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "git", "handoffThread")).not.toHaveBeenCalled();
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

  it("routes cwd-keyed calls by PATH, not by an id they do not carry", () => {
    // These identify their target by a bare path and have no thread or project
    // id, so the id table cannot resolve them and must not pretend to. They
    // belong to the path table instead — the two are kept disjoint at
    // type-check time so no call is resolved by two rules that could disagree.
    for (const method of ["checkout", "status", "createWorktree", "stageFiles", "pull"]) {
      expect(ROUTED_METHODS.git as readonly string[]).not.toContain(method);
      expect(CWD_ROUTED_METHODS.git as readonly string[]).toContain(method);
    }
    // Carries BOTH keys; the id is the more specific one and wins.
    expect(ROUTED_METHODS.git as readonly string[]).toContain("handoffThread");
    expect(CWD_ROUTED_METHODS.git as readonly string[]).not.toContain("handoffThread");
    // Whole groups that are path-keyed only.
    expect(Object.keys(ROUTED_METHODS)).not.toContain("projects");
    expect(Object.keys(CWD_ROUTED_METHODS)).toContain("projects");
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

  it("resolves the attachment CANCEL route on the same host that staged it", () => {
    // Cancel is the half that was missed once already. Pointed at the local
    // server it cancels nothing while the remote host's staged bytes sit until
    // they expire — a compensating action that silently compensates the wrong
    // machine.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    const upload = new URL(resolveThreadHttpUrl(REMOTE_THREAD_ID, "/api/attachments/upload"));
    const cancel = new URL(resolveThreadHttpUrl(REMOTE_THREAD_ID, "/api/attachments/cancel"));
    expect(cancel.origin).toBe(upload.origin);
    expect(cancel.origin).toBe("https://vps.example.com");
  });

  it("keeps a local thread's upload on the local server", () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    // No throw, and no remote origin: the ambient local resolution is preserved
    // exactly as it was, so single-server installs are unaffected.
    expect(() => resolveThreadHttpUrl(LOCAL_THREAD_ID, "/api/attachments/upload")).not.toThrow();
  });

  it("sends a remote thread's attachment bytes AND its cancel to that host", async () => {
    // The CALL SITE, not just the resolver: composerSend must actually route
    // both routes, and pinning only `resolveThreadHttpUrl` left that unproven —
    // with a single local environment both spellings produce the same relative
    // URL, so a call site that forgot to route looked identical.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    ownThread(REMOTE_ENVIRONMENT_ID, REMOTE_THREAD_ID);

    const file = new File(["one"], "one.png", { type: "image/png" });
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      requestedUrls.push(String(input));
      // First upload succeeds so an id is staged; the second fails, which is
      // what triggers the cancel of the first.
      if (requestedUrls.length === 1) {
        return Response.json(
          {
            type: "image",
            id: `${REMOTE_THREAD_ID}-11111111-1111-4111-8111-111111111111`,
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
          },
          { status: 201 },
        );
      }
      if (requestedUrls.length === 2) {
        return Response.json({ error: "Second upload failed." }, { status: 500 });
      }
      return Response.json({ cancelled: true }, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const image = (id: string) => ({
      type: "image" as const,
      id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: `blob:${id}`,
      file,
    });

    await expect(
      stageUploadComposerAttachments({
        threadId: REMOTE_THREAD_ID,
        images: [image("draft-one"), image("draft-two")],
        files: [],
        assistantSelections: [],
      }),
    ).rejects.toThrow("Second upload failed.");

    vi.unstubAllGlobals();

    // Every request — both uploads and the compensating cancel — went to the
    // REMOTE host. A single one resolving locally means a remote thread's file
    // bytes landed on the user's laptop, or its staged bytes were never freed.
    expect(requestedUrls).toHaveLength(3);
    for (const url of requestedUrls) {
      expect(new URL(url).origin).toBe("https://vps.example.com");
    }
    expect(requestedUrls[2]).toContain("/api/attachments/cancel");
  });
});

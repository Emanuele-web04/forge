// FILE: environmentRoutedApi.ts
// Purpose: One choke point that sends every THREAD- and PROJECT-scoped call to
//          the environment that owns it.
// Layer: Web transport routing
// Exports: createEnvironmentRoutedApi, ROUTED_METHODS, LOCAL_ONLY_THREAD_METHODS
//
// SCOPE: every call that names a target. Thread- and project-keyed calls route
// by their id (ROUTED_METHODS); calls keyed by a bare `cwd` route by PATH
// OWNERSHIP (CWD_ROUTED_METHODS), which can also answer "unknown" and refuse.
// Both sets are enforced against the NativeApi contract at type-check time.

import type { NativeApi, ThreadId } from "@synara/contracts";

import {
  environmentNativeApi,
  EnvironmentUnavailableError,
  findThreadEnvironmentId,
  resolveProjectEnvironmentId,
  resolveSpaceEnvironmentId,
  resolveThreadEnvironmentId,
} from "./environmentRouting";
import {
  resolvePathEnvironment,
  UnknownPathEnvironmentError,
  unknownPathRefusalMessage,
} from "./environmentPathRouting";
import {
  automationProjectId,
  recordAutomationOwnership,
  runProjectId,
} from "./environmentAutomationOwnership";
import { environmentLabel } from "./environmentDirectory";
import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { useStore } from "./store";

/**
 * Groups of the NativeApi that carry thread-scoped methods, and the methods in
 * each that are routed to the thread's own server.
 *
 * This is a routing decision, not a wire change: `environmentId` never enters
 * any request schema. It only decides which per-environment NativeApi receives
 * the call.
 *
 * Membership here is not a matter of taste — `environmentRouting.test.ts`
 * derives the thread-scoped set from the NativeApi CONTRACT and fails at
 * TYPE-CHECK time if a method whose input names a thread is missing from this
 * table and is not explicitly excused in `LOCAL_ONLY_THREAD_METHODS`.
 */
export const ROUTED_METHODS = {
  orchestration: [
    "dispatchCommand",
    "getThreadDetailSnapshot",
    "importThread",
    "getTurnDiff",
    "getFullThreadDiff",
    "reconcileProviderDelivery",
    "listProviderDeliveryBlockers",
    "subscribeThread",
    "unsubscribeThread",
  ],
  // A terminal is a PTY on the machine that runs the thread. Unrouted, a user
  // who opens a terminal in a remote thread and types a deploy command runs it
  // on their laptop.
  terminal: ["open", "write", "ackOutput", "resize", "clear", "restart", "close"],
  // Compaction rewrites the thread's own transcript, which only its host has.
  provider: ["compactThread"],
  // Studio outputs are files the thread produced, on the thread's host.
  studio: ["listThreadOutputs"],
  // Carries BOTH threadId and cwd, and runs `git` against a working tree.
  // Unrouted, a remote thread's handoff mutates the LOCAL checkout.
  git: ["handoffThread"],
} as const satisfies { readonly [G in keyof NativeApi]?: ReadonlyArray<keyof NativeApi[G]> };

/**
 * Thread-scoped methods that are deliberately NOT routed, and why.
 *
 * The embedded browser is a webview surface on the USER'S machine — a panel in
 * their own window — not a resource belonging to the thread's host. Routing
 * these would send webview control to a headless VPS that has no display.
 * `wsNativeApi.ts` implements them against `window.desktopBridge` or an
 * in-memory fallback workspace, never against the transport, so routing them
 * would also be a no-op at best.
 *
 * This list exists so that "not routed" is an explicit, reviewed decision
 * rather than an omission: the contract test requires every thread-scoped
 * method to appear in exactly one of these two tables.
 */
export const LOCAL_ONLY_THREAD_METHODS = {
  browser: [
    "open",
    "close",
    "hide",
    "getState",
    "setPanelBounds",
    "attachWebview",
    "detachWebview",
    "copyLink",
    "copyScreenshotToClipboard",
    "captureScreenshot",
    "navigate",
    "reload",
    "goBack",
    "goForward",
    "newTab",
    "closeTab",
    "selectTab",
    "openDevTools",
    "annotations",
  ],
} as const satisfies { readonly [G in keyof NativeApi]?: ReadonlyArray<keyof NativeApi[G]> };

/**
 * `cwd`-keyed methods routed by PATH OWNERSHIP rather than by a thread or
 * project id.
 *
 * These inputs identify their target by a bare filesystem path and carry no
 * routing key of their own. Unrouted they all ran on the LOCAL server, and
 * because `/Users/me/dev/foo` plausibly exists on both machines the failure was
 * not an error but a SILENT SUCCESS against the wrong checkout — `git.checkout`
 * or `projects.writeFile` landing on the laptop while the UI said the thread
 * ran on a remote host. Data loss, not a wrong result.
 *
 * Resolution is `resolvePathEnvironment` (environmentPathRouting.ts), which
 * answers local / remote / UNKNOWN. Unknown is a value this module must handle,
 * not something that decays to local: with no remote host registered it means
 * local (a local-only install is unchanged), and once a remote host exists it
 * REFUSES naming the path.
 *
 * Membership is enforced against the contract at type-check time by
 * `environmentRoutingCoverage.test-d.ts`, exactly as for thread-scoped methods.
 */
export const CWD_ROUTED_METHODS = {
  git: [
    "checkout",
    "createBranch",
    "createDetachedWorktree",
    "createWorktree",
    "githubRepository",
    "init",
    "listBranches",
    "preparePullRequestThread",
    "pull",
    "pullRequestSnapshot",
    "readWorkingTreeDiff",
    "removeIndexLock",
    "removeWorktree",
    "resolvePullRequest",
    "runStackedAction",
    "stageFiles",
    "stashAndCheckout",
    "stashDrop",
    "stashInfo",
    "status",
    "summarizeDiff",
    "unstageFiles",
    "workingTreeDiffStats",
  ],
  projects: [
    "discoverScripts",
    "listDirectories",
    "readFile",
    "runDevServer",
    "searchEntries",
    "writeFile",
  ],
  // Discovery reads config and binaries from the checkout's own machine: a
  // remote thread's available models, agents, skills and plugins are the REMOTE
  // host's. Several of these take an OPTIONAL `cwd`; when it is absent the call
  // resolves local, which is the same answer as before — there is no path to
  // send anywhere.
  provider: [
    "listAgents",
    "listCommands",
    "listModels",
    "listPlugins",
    "listSkills",
    "listSkillsCatalog",
    "readPlugin",
  ],
  // Both read the thread's working tree to build their prompt.
  server: ["generateAutomationIntent", "generateThreadRecap"],
} as const satisfies { readonly [G in keyof NativeApi]?: ReadonlyArray<keyof NativeApi[G]> };

/**
 * `cwd`-keyed methods deliberately routed by something OTHER than the path, or
 * not routed at all, and why.
 *
 * Every one of these carries a `cwd` but must not be resolved by it:
 *   - `terminal.open` / `terminal.restart` and `git.handoffThread` also carry
 *     `threadId`, which is the more specific key and is already routed by
 *     `ROUTED_METHODS`. Routing them twice could disagree with itself.
 *   - `browser.annotations` is a webview surface on the user's own machine
 *     (see LOCAL_ONLY_THREAD_METHODS).
 *   - `server.transcribeVoice` uploads audio recorded by the user's microphone
 *     and is addressed per-environment by `wsNativeApi` already; its `cwd` is
 *     context for the transcript, not the resource being acted on.
 *   - `filesystem.browse` shows the machine the USER is sitting at. On a remote
 *     host it would list the wrong machine's folders under the right names, so
 *     it is REFUSED by the `local-filesystem-browse` capability
 *     (environmentCapabilities.ts) rather than routed: the answer has to come
 *     from this machine or not at all.
 */
export const CWD_LOCAL_OR_THREAD_ROUTED_METHODS = {
  terminal: ["open", "restart"],
  git: ["handoffThread"],
  browser: ["annotations"],
  server: ["transcribeVoice"],
  filesystem: ["browse"],
} as const satisfies { readonly [G in keyof NativeApi]?: ReadonlyArray<keyof NativeApi[G]> };

/**
 * Methods whose FIRST POSITIONAL ARGUMENT is a filesystem path.
 *
 * `shell.openInEditor(cwd, editor)` and `shell.showInFolder(path)` pass the
 * path directly rather than as a field, so the contract-derived `cwd` check
 * structurally cannot see them — the known limit documented in
 * `environmentRoutingCoverage.test-d.ts`. The panel showed the gap is reachable
 * from real UI (a keyboard shortcut and the project context menu), not
 * theoretical.
 *
 * These are DESKTOP surfaces: they open an editor window or a file manager on
 * the machine the user is sitting at. So the answer is not to route them — a
 * headless host has no display — but to REFUSE when the path belongs to another
 * host, which is what `environmentCapabilities` already says should happen.
 * Falling through opens the LOCAL machine's copy of that path: the same file
 * name, a different machine's contents, and it looks like it worked.
 *
 * Listed by ARGUMENT INDEX because there is no field name to match on. Anything
 * added here must take its path as `args[index]`.
 */
export const POSITIONAL_PATH_METHODS = {
  shell: { openInEditor: 0, showInFolder: 0 },
} as const satisfies {
  readonly [G in keyof NativeApi]?: { readonly [M in keyof NativeApi[G]]?: number };
};

/**
 * Methods keyed by `projectId` and routed to the project's owning host.
 *
 * A project belongs to one server, so anything scoped to it acts on that
 * server's resources: a dev server runs on the machine holding the checkout,
 * and a pull request is opened against the remote that machine has configured.
 * Unrouted, stopping a remote project's dev server killed nothing while the
 * real process kept running, and a PR action was attempted against the LOCAL
 * server's idea of the repository.
 *
 * Resolution is `resolveProjectEnvironmentId` — positional, the same rule the
 * aggregate view uses, so the project acted on is the one whose row is shown.
 */
export const PROJECT_ROUTED_METHODS = {
  projects: ["stopDevServer"],
  // `list` and `reviewRequestCount` take an OPTIONAL, NULLABLE projectId. When
  // one is supplied the query is scoped to that project and must run on its
  // host; when absent it is a server-wide query and resolves local, exactly as
  // before. They were invisible to the coverage check until its matcher learned
  // to see `string | null | undefined`.
  pullRequests: ["action", "comment", "detail", "diff", "list", "reviewRequestCount", "setPinned"],
  // An automation runs turns in its project's checkout, so it belongs to that
  // project's host. `update` takes an OPTIONAL projectId — when absent the call
  // resolves local, the same answer as before, since nothing names another host.
  // `create`/`update` carry projectId. The rest carry only automationId or
  // runId and are resolved through the ownership index — without them a user
  // could create an automation on a remote host and then run, cancel or delete
  // it against the LOCAL server.
  automation: [
    "archiveRun",
    "cancelRun",
    "create",
    "delete",
    "getMemory",
    "markRunRead",
    "resolveProposal",
    "runNow",
    "update",
  ],
} as const satisfies { readonly [G in keyof NativeApi]?: ReadonlyArray<keyof NativeApi[G]> };

/**
 * `projectId`-keyed methods routed by something else, or deliberately local.
 *
 *   - `projects.runDevServer` carries `cwd` ALONGSIDE `projectId` and is
 *     already path-routed. Both keys name the same host, and routing it twice
 *     could disagree with itself.
 *   - `browser.annotations` is a webview surface on the user's own machine
 *     (see LOCAL_ONLY_THREAD_METHODS).
 */
export const PROJECT_LOCAL_OR_OTHER_ROUTED_METHODS = {
  projects: ["runDevServer"],
  browser: ["annotations"],
} as const satisfies { readonly [G in keyof NativeApi]?: ReadonlyArray<keyof NativeApi[G]> };

function readStringField(argument: unknown, field: string): string | null {
  if (typeof argument !== "object" || argument === null) return null;
  const candidate = (argument as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

/**
 * The environment a call belongs to, or `null` when the call is not scoped to
 * one and should stay on the local (server-wide) client.
 *
 * Keys are tried in order of how specifically they identify a host: a KNOWN
 * thread, then the owning project, then the projects a space command names.
 *
 * The thread step uses `findThreadEnvironmentId`, which distinguishes "owned by
 * local" from "nobody has said". That distinction is load-bearing for
 * `thread.create`, which carries a brand-new `threadId` no snapshot has
 * reported ALONGSIDE the `projectId` that does identify a host: resolving the
 * unknown thread straight to local would create a remote project's thread on
 * the user's laptop whenever the composer claim is missing or has been
 * released. Falling through to the project is what makes the claim an
 * optimization rather than the only thing standing between the user and a
 * thread on the wrong machine.
 *
 * The project step also covers commands that carry no thread at all
 * (`project.meta.update`, `project.delete`): without it, pinning, renaming, or
 * deleting a REMOTE project would be applied to the local server's copy.
 *
 * Ownership is positional, so each lookup is a scan of the environment records.
 * The state is read ONCE here and threaded through every step: re-reading it
 * per key would both rescan and — worse — let a snapshot land between the
 * thread step and the project step, resolving one call against two different
 * views of who owns what.
 */
function resolveCallEnvironmentId(
  argument: unknown,
): ReturnType<typeof resolveThreadEnvironmentId> | null {
  const state = useStore.getState();
  const threadId = readStringField(argument, "threadId");
  const threadEnvironmentId =
    threadId === null ? null : findThreadEnvironmentId(threadId as ThreadId, state);
  if (threadEnvironmentId !== null) return threadEnvironmentId;

  const projectId = readStringField(argument, "projectId");
  if (projectId !== null) return resolveProjectEnvironmentId(projectId, state);

  // A thread nobody has claimed and no project names runs where the app does.
  if (threadId !== null) return resolveThreadEnvironmentId(threadId as ThreadId, state);

  // `space.projects.assign` names the projects it moves; they share an owner.
  // Checked BEFORE spaceId: that command carries both, and the projects are the
  // thing being moved, so they are the more specific claim about which server
  // the write lands on.
  const projectIds = (argument as { readonly projectIds?: unknown } | null)?.projectIds;
  if (Array.isArray(projectIds)) {
    const first = projectIds.find((id): id is string => typeof id === "string");
    if (first !== undefined) return resolveProjectEnvironmentId(first, state);
  }

  // Space commands carry ONLY a spaceId. Without this they dispatched to the
  // LOCAL server while the aggregated sidebar showed remote spaces, so deleting
  // or renaming a remote space did nothing — or hit a local space sharing the
  // id. `space.reorder` also carries `orderedSpaceIds`, but its own `spaceId`
  // already names the owner, and a reorder spanning two servers is not
  // expressible in one command anyway.
  const spaceId = readStringField(argument, "spaceId");
  if (spaceId !== null) return resolveSpaceEnvironmentId(spaceId, state);

  // Automations and their runs carry neither a thread, a project nor a path —
  // only their own id. `create` and `update` DO carry projectId and were
  // routed, so a user could create an automation on a remote host and then
  // run, cancel or delete it against the LOCAL server, which does not have it.
  //
  // Resolved indirectly: every automation and run names its project, and
  // projects are positional. `automationProjectId` is a cache of what the app
  // has already listed, so an id nobody has reported yields null and falls
  // through to local — the same answer as before, never worse.
  const automationId = readStringField(argument, "automationId");
  const runId = readStringField(argument, "runId");
  const ownerProjectId =
    (automationId === null ? null : automationProjectId(automationId)) ??
    (runId === null ? null : runProjectId(runId));
  if (ownerProjectId !== null) return resolveProjectEnvironmentId(ownerProjectId, state);

  return null;
}

/**
 * Wraps `localApi` so a thread- or project-scoped call is dispatched against
 * the server that owns it.
 *
 * The wrapper is applied to the LOCAL client, which is what every existing
 * caller already holds. That is deliberate: routing that must be opted into at
 * each of hundreds of call sites is routing that will be forgotten at one of
 * them, and the failure mode — a remote thread's turn running on the user's
 * laptop — is silent. Here a caller cannot bypass it without reaching into the
 * registry directly.
 *
 * A call whose owning environment is not connected produces an explicit
 * `EnvironmentUnavailableError`; it never falls back to local.
 */
export function createEnvironmentRoutedApi(localApi: NativeApi): NativeApi {
  const routed = { ...localApi } as unknown as Record<string, Record<string, unknown>>;

  for (const [group, methods] of Object.entries(ROUTED_METHODS)) {
    const localGroup = localApi[group as keyof NativeApi] as Record<string, unknown> | undefined;
    if (!localGroup) continue;
    const routedGroup: Record<string, unknown> = { ...localGroup };

    for (const method of methods as ReadonlyArray<string>) {
      const localImplementation = localGroup[method];
      if (typeof localImplementation !== "function") continue;

      routedGroup[method] = (...args: readonly unknown[]) => {
        const environmentId = resolveCallEnvironmentId(args[0]);
        // Null means "no owner named"; LOCAL means "the owner IS this server".
        // Both run the implementation we were HANDED, never one re-fetched from
        // the registry. The id resolvers default to LOCAL rather than null, so
        // re-fetching sent every unowned call to `localWsEnvironmentClient()`,
        // bypassing the injected local api and dispatching into a client that
        // resolves nothing before its socket is up. Ten browser tests failed
        // with `expected undefined to match object { _tag: "automation.create" }`
        // — the command was never delivered to the api under test.
        if (environmentId === null || environmentId === LOCAL_ENVIRONMENT_ID) {
          return (localImplementation as (...a: readonly unknown[]) => unknown)(...args);
        }
        const owner = environmentNativeApi(environmentId);
        if (!owner) return Promise.reject(new EnvironmentUnavailableError(environmentId));
        const ownerGroup = owner[group as keyof NativeApi] as Record<string, unknown>;
        return (ownerGroup[method] as (...a: readonly unknown[]) => unknown)(...args);
      };
    }

    routed[group] = routedGroup;
  }

  for (const [group, methods] of Object.entries(CWD_ROUTED_METHODS)) {
    const localGroup = localApi[group as keyof NativeApi] as Record<string, unknown> | undefined;
    if (!localGroup) continue;
    // Start from whatever the thread/project pass produced for this group, so a
    // group carrying BOTH kinds (git) keeps its already-routed members.
    const routedGroup: Record<string, unknown> = { ...(routed[group] ?? localGroup) };

    for (const method of methods as ReadonlyArray<string>) {
      const localImplementation = localGroup[method];
      if (typeof localImplementation !== "function") continue;

      routedGroup[method] = (...args: readonly unknown[]) => {
        const resolution = resolvePathEnvironment(
          useStore.getState(),
          readStringField(args[0], "cwd"),
        );
        if (resolution.kind === "local") {
          return (localImplementation as (...a: readonly unknown[]) => unknown)(...args);
        }
        // Refuse rather than guess. Reached only when a remote host is
        // registered, so the path really is ambiguous and running it on the
        // wrong machine could change the wrong files.
        if (resolution.kind === "unknown") {
          return Promise.reject(new UnknownPathEnvironmentError(resolution.path));
        }
        const owner = environmentNativeApi(resolution.environmentId);
        if (!owner)
          return Promise.reject(new EnvironmentUnavailableError(resolution.environmentId));
        const ownerGroup = owner[group as keyof NativeApi] as Record<string, unknown>;
        return (ownerGroup[method] as (...a: readonly unknown[]) => unknown)(...args);
      };
    }

    routed[group] = routedGroup;
  }

  for (const [group, methods] of Object.entries(PROJECT_ROUTED_METHODS)) {
    const localGroup = localApi[group as keyof NativeApi] as Record<string, unknown> | undefined;
    if (!localGroup) continue;
    // Start from the previous passes' result so a group carrying several key
    // kinds keeps its already-routed members.
    const routedGroup: Record<string, unknown> = { ...(routed[group] ?? localGroup) };

    for (const method of methods as ReadonlyArray<string>) {
      const localImplementation = localGroup[method];
      if (typeof localImplementation !== "function") continue;

      routedGroup[method] = (...args: readonly unknown[]) => {
        // The FULL resolver, not a bare `projectId` read. These methods are
        // keyed several ways — projectId directly, or an automationId/runId
        // that names its project — and a loop that only knew about projectId
        // silently ran every automation command locally while `create` and
        // `update` routed correctly. One resolver means a key added there is
        // honoured here without anyone remembering to update this loop.
        const environmentId = resolveCallEnvironmentId(args[0]);
        // Nothing identifies another host: a server-wide call that stays where
        // it always ran.
        if (environmentId === null) {
          return (localImplementation as (...a: readonly unknown[]) => unknown)(...args);
        }
        const owner = environmentNativeApi(environmentId);
        if (!owner) return Promise.reject(new EnvironmentUnavailableError(environmentId));
        const ownerGroup = owner[group as keyof NativeApi] as Record<string, unknown>;
        return (ownerGroup[method] as (...a: readonly unknown[]) => unknown)(...args);
      };
    }

    routed[group] = routedGroup;
  }

  // Learn automation ownership from whatever the app lists.
  //
  // Wrapped HERE rather than at each call site for the same reason routing is:
  // there are several list callers and an index fed by only some of them is an
  // index that resolves for some ids and not others. `automation.list` returns
  // both definitions and runs, each naming its project, so one hook teaches the
  // resolver everything a listing knows.
  const automationGroup = routed.automation ?? (localApi.automation as never);
  if (automationGroup && typeof automationGroup.list === "function") {
    const localList = automationGroup.list as (...a: readonly unknown[]) => Promise<unknown>;
    routed.automation = {
      ...automationGroup,
      list: async (...args: readonly unknown[]) => {
        const result = (await localList(...args)) as {
          readonly definitions?: ReadonlyArray<{ readonly id: string; readonly projectId: string }>;
          readonly runs?: ReadonlyArray<{
            readonly id: string;
            readonly automationId: string;
            readonly projectId: string;
          }>;
        };
        recordAutomationOwnership({
          automations: result?.definitions as never,
          runs: result?.runs as never,
        });
        return result;
      },
    };
  }

  for (const [group, methods] of Object.entries(POSITIONAL_PATH_METHODS)) {
    const localGroup = localApi[group as keyof NativeApi] as Record<string, unknown> | undefined;
    if (!localGroup) continue;
    const routedGroup: Record<string, unknown> = { ...(routed[group] ?? localGroup) };

    for (const [method, index] of Object.entries(methods as Record<string, number>)) {
      const localImplementation = localGroup[method];
      if (typeof localImplementation !== "function") continue;

      routedGroup[method] = (...args: readonly unknown[]) => {
        const path = args[index];
        const resolution = resolvePathEnvironment(
          useStore.getState(),
          typeof path === "string" ? path : null,
        );
        // Local, or a path nobody claims while only one host exists: unchanged.
        if (resolution.kind === "local") {
          return (localImplementation as (...a: readonly unknown[]) => unknown)(...args);
        }
        // Refuse rather than open the LOCAL copy of a path that belongs
        // elsewhere. These are desktop surfaces on the user's own machine, so
        // routing them to a headless host would not help either.
        const label =
          resolution.kind === "remote"
            ? environmentLabel(resolution.environmentId)
            : resolution.path;
        return Promise.reject(
          new Error(
            resolution.kind === "remote"
              ? `That folder lives on ${label}. Editors and file managers open on this computer, so Synara cannot open it from here — open it from Synara running on ${label}.`
              : unknownPathRefusalMessage(label),
          ),
        );
      };
    }

    routed[group] = routedGroup;
  }

  return routed as unknown as NativeApi;
}

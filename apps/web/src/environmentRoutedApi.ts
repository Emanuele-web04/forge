// FILE: environmentRoutedApi.ts
// Purpose: One choke point that sends every THREAD- and PROJECT-scoped call to
//          the environment that owns it.
// Layer: Web transport routing
// Exports: createEnvironmentRoutedApi, ROUTED_METHODS, LOCAL_ONLY_THREAD_METHODS
//
// SCOPE: thread- and project-keyed calls only. Calls keyed by a bare `cwd`
// path are NOT routed and still run locally — see the KNOWN GAP note above
// `readStringField` before assuming any operation follows a thread to its host.

import type { NativeApi, ThreadId } from "@synara/contracts";

import {
  environmentNativeApi,
  EnvironmentUnavailableError,
  findThreadEnvironmentId,
  resolveProjectEnvironmentId,
  resolveThreadEnvironmentId,
} from "./environmentRouting";
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
 * KNOWN GAP — `cwd`-keyed calls are NOT routed. Do not read this module as
 * covering them.
 *
 * Roughly 35 inputs identify their target by a bare filesystem path (`cwd`)
 * and carry no thread or project id: 22 `git.*` methods (checkout,
 * createBranch, createWorktree, stageFiles, pull, status, ...), 6 `project.*`
 * (readFile, writeFile, runDevServer, ...), `filesystem.browse`,
 * `shell.openInEditor`, `provider.listModels`/`listAgents`/`skillsCatalog`,
 * and two `server.generate*` methods. A path carries no host identity, so the
 * thread/project key this module routes on cannot answer for them, and they
 * all run on the LOCAL server.
 *
 * Why this is worse than a plain missing feature: `/Users/me/dev/foo`
 * plausibly exists on BOTH machines. The failure is therefore not an error but
 * a SILENT SUCCESS against the wrong checkout — `git.checkout` or
 * `project.writeFile` landing on the laptop while the UI says the thread runs
 * on a remote host. That is data loss, not a wrong result.
 *
 * `git.handoffThread` is the one member of that family fixable today, because
 * it happens to carry `threadId` alongside `cwd`; it is routed above.
 *
 * The agreed fix is a path-ownership index over project `workspaceRoot` and
 * thread `worktreePath` feeding a three-state resolver
 * (`local` | `remote` | `unknown`), where `unknown` resolves local while no
 * remote host is registered and refuses once one is. It is deliberately NOT in
 * this change: it is a larger, separately-reviewable piece of work. Until it
 * lands, any UI that lets a user create work on a remote host must not imply
 * that path-scoped operations follow it there.
 */
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
  const projectIds = (argument as { readonly projectIds?: unknown } | null)?.projectIds;
  if (Array.isArray(projectIds)) {
    const first = projectIds.find((id): id is string => typeof id === "string");
    if (first !== undefined) return resolveProjectEnvironmentId(first, state);
  }

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

  return routed as unknown as NativeApi;
}

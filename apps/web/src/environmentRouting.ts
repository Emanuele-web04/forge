// FILE: environmentRouting.ts
// Purpose: Resolve the environment that OWNS a thread, so every dispatch and
//          every HTTP-backed request reaches that thread's own server.
// Layer: Web transport routing
// Exports: ownership resolution, per-thread NativeApi/HTTP resolution, and the
//          explicit refusals that replace a silent local fallback.
//
// Ownership is POSITIONAL: a thread belongs to the environment whose record
// holds it. This module does not keep its own map of that — it reads the store
// through `findEnvironmentIdForThread` / `findEnvironmentIdForProject`, which
// are the same lookups the aggregate view resolves collisions with. A second
// ownership table here would be a second answer to "which server owns this",
// and the two would drift.

import type { EnvironmentId, NativeApi, ThreadId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import {
  findEnvironmentIdForProject,
  findEnvironmentIdForSpace,
  findEnvironmentIdForThread,
} from "./storeAggregation";
import { getWsEnvironmentClient, localWsEnvironmentClient } from "./wsEnvironmentRegistry";
import { resolveEnvironmentHttpUrl } from "./lib/wsHttpUrl";
import {
  threadDetailResumeCursors,
  type ThreadDetailResumeCursorScope,
} from "./threadDetailResumeCursors";
import { useStore } from "./store";
import type { AppState } from "./storeState";
import type { Project, Space } from "./types";

/**
 * Threads a client has decided to create on a remote environment but which no
 * snapshot has reported yet.
 *
 * A brand-new thread exists in no environment record until `thread.create`
 * lands, so positional ownership cannot answer for it — and defaulting to local
 * is exactly the bug this module exists to prevent. The composer claims the
 * environment when the user picks it, before the first dispatch.
 *
 * This is not an ownership table: it holds only ids no server has reported, and
 * a snapshot always outranks it (see `resolveThreadEnvironmentId`).
 */
const claimedEnvironmentIdByThreadId = new Map<ThreadId, EnvironmentId>();

export function claimThreadEnvironment(threadId: ThreadId, environmentId: EnvironmentId): void {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    claimedEnvironmentIdByThreadId.delete(threadId);
    return;
  }
  claimedEnvironmentIdByThreadId.set(threadId, environmentId);
}

export function releaseThreadEnvironmentClaim(threadId: ThreadId): void {
  claimedEnvironmentIdByThreadId.delete(threadId);
}

/** Test/reset seam; production never clears every claim at once. */
export function resetThreadEnvironmentClaims(): void {
  claimedEnvironmentIdByThreadId.clear();
}

/**
 * The store state ownership is read from.
 *
 * A parameter so tests and non-React callers can resolve against a state they
 * hold, rather than this module reaching for a global at every lookup.
 */
export type ThreadOwnershipSource = AppState;

function readOwnershipSource(): ThreadOwnershipSource {
  return useStore.getState();
}

/**
 * The environment that owns `threadId`.
 *
 * Snapshot-reported ownership wins over a local claim: an environment record is
 * the only authority on where a thread actually lives, and a stale claim must
 * never outrank it. Only when no environment holds the thread does the claim
 * apply, which is precisely the pre-create window.
 */
export function resolveThreadEnvironmentId(
  threadId: ThreadId,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId {
  return findThreadEnvironmentId(threadId, source) ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * Ownership of `threadId` when some environment or the composer has actually
 * stated it, and `null` when nobody has.
 *
 * `resolveThreadEnvironmentId` cannot express "nobody knows" — it answers LOCAL
 * for an unknown thread, which is the right default for a thread being read but
 * the wrong one for a thread being CREATED. `thread.create` carries a brand-new
 * `threadId` no snapshot has reported, so a caller that needs to fall back to
 * another key (the owning project) must be able to tell the two apart.
 */
export function findThreadEnvironmentId(
  threadId: ThreadId,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId | null {
  const reported = findEnvironmentIdForThread(source, threadId);
  if (reported) return reported;
  return claimedEnvironmentIdByThreadId.get(threadId) ?? null;
}

/**
 * The environment that owns `projectId`.
 *
 * Project-scoped commands (`project.meta.update`, `project.delete`,
 * `space.projects.assign`) carry no thread, so thread ownership cannot answer
 * for them. Without this, pinning or deleting a project that lives on a remote
 * host mutates the LOCAL server's copy instead.
 */
export function resolveProjectEnvironmentId(
  projectId: string,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId {
  // Accepts a bare string, not the branded `ProjectId`: the routed API reads
  // this field off an untyped request argument, so the brand cannot be honestly
  // proven at the call site. The lookup only ever compares it against ids the
  // store already holds, so an id that is not a real project matches nothing
  // and resolves local — the same answer as an absent field.
  return findEnvironmentIdForProject(source, projectId as Project["id"]) ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * The environment that owns `spaceId`.
 *
 * Space commands (`space.meta.update`, `space.delete`, `space.reorder`) carry
 * ONLY a spaceId — no thread and no project — so neither of the lookups above
 * can answer for them. Unrouted they ran on the LOCAL server while the
 * aggregated sidebar showed remote spaces: deleting a remote space deleted
 * nothing, or silently deleted a local space that happened to share the id.
 */
export function resolveSpaceEnvironmentId(
  spaceId: string,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId {
  // Bare string for the same reason `resolveProjectEnvironmentId` takes one:
  // the routed API reads this off an untyped request argument, so the brand
  // cannot be honestly proven at the call site. An id no environment holds
  // matches nothing and resolves local — the same answer as an absent field.
  return findEnvironmentIdForSpace(source, spaceId as Space["id"]) ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * Resume cursors for the environment that OWNS `threadId`.
 *
 * The correct accessor for any thread-keyed cursor read or write. A sequence is
 * only meaningful inside the journal that issued it, and two servers both
 * starting at sequence 1 is the normal case rather than an anomaly — so filing
 * a remote thread's sequence under the LOCAL scope both loses the real cursor
 * and poisons the local space with a number from another journal.
 *
 * Lives here rather than beside the cursor store because resolution needs the
 * store, and `storeProjection` already imports the cursor store — importing the
 * store back from there would close an import cycle.
 */
export function threadResumeCursors(threadId: ThreadId): ThreadDetailResumeCursorScope {
  return threadDetailResumeCursors(resolveThreadEnvironmentId(threadId));
}

/**
 * Message shown when a thread's owning environment is not connected.
 *
 * Every caller surfaces this instead of falling back to the local server: a
 * silent fallback would run a remote thread's turn — or upload its attachment
 * bytes — on the wrong machine.
 */
export function unreachableEnvironmentMessage(environmentId: EnvironmentId): string {
  return `This chat runs on remote environment ${environmentId}, which is not connected right now. Reconnect that host from Settings → Remote hosts, then try again.`;
}

export class EnvironmentUnavailableError extends Error {
  readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId) {
    super(unreachableEnvironmentMessage(environmentId));
    this.name = "EnvironmentUnavailableError";
    this.environmentId = environmentId;
  }
}

/**
 * The NativeApi for one environment, or `undefined` when that environment is
 * not connected. The local environment connects on demand; a remote one is
 * never auto-connected because only its registration knows its URL.
 */
export function environmentNativeApi(environmentId: EnvironmentId): NativeApi | undefined {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return localWsEnvironmentClient().api;
  return getWsEnvironmentClient(environmentId)?.api;
}

/** The NativeApi that owns `threadId`, or `undefined` when it is not connected. */
export function threadNativeApi(threadId: ThreadId): NativeApi | undefined {
  return environmentNativeApi(resolveThreadEnvironmentId(threadId));
}

/** Like `threadNativeApi`, but refuses explicitly rather than returning nothing. */
export function ensureThreadNativeApi(threadId: ThreadId): NativeApi {
  const environmentId = resolveThreadEnvironmentId(threadId);
  const api = environmentNativeApi(environmentId);
  if (!api) throw new EnvironmentUnavailableError(environmentId);
  return api;
}

/**
 * HTTP URL for `rawPath` on the server that owns `threadId`.
 *
 * Throws for an unregistered remote environment rather than resolving through
 * the page's ambient WS URL — an ambient resolution here sends the request body
 * (attachment bytes, an export request) to the local server.
 */
export function resolveThreadHttpUrl(threadId: ThreadId, rawPath: string): string {
  const environmentId = resolveThreadEnvironmentId(threadId);
  if (environmentId === LOCAL_ENVIRONMENT_ID) return resolveEnvironmentHttpUrl(null, rawPath);
  const client = getWsEnvironmentClient(environmentId);
  if (!client) throw new EnvironmentUnavailableError(environmentId);
  return resolveEnvironmentHttpUrl(client.wsUrl, rawPath);
}

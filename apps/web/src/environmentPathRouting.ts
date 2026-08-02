// FILE: environmentPathRouting.ts
// Purpose: Resolve which host owns a bare filesystem path, so `cwd`-keyed calls
//          reach the machine whose checkout they mean.
// Layer: Web transport routing
// Exports: the path-ownership index, the three-state resolver, and its refusal.
//
// THE PROBLEM
//
// ~34 NativeApi inputs identify their target by a bare `cwd` and carry no
// thread or project id: 22 `git.*` (checkout, createWorktree, stageFiles, pull,
// status, ...), 6 `project.*` (readFile, writeFile, runDevServer, ...),
// `filesystem.browse`, `shell.openInEditor`, and others. A path carries no host
// identity, so the thread/project key `environmentRoutedApi` routes on cannot
// answer for them.
//
// Why that is worse than a missing feature: `/Users/me/dev/foo` plausibly
// exists on BOTH machines. An unrouted call is therefore not an error but a
// SILENT SUCCESS against the wrong checkout — `git.checkout` or
// `project.writeFile` landing on the laptop while the UI says the thread runs
// on a remote host. That is data loss, not a wrong result.
//
// WHAT THIS KEYS ON, AND WHAT IT MUST NEVER KEY ON
//
// Ownership comes ONLY from the store's positional records: a project's `cwd`
// paired with the environment whose record holds that project, and a thread's
// `worktreePath` paired with the environment whose record holds that thread.
//
// Nothing here stats the filesystem, compares hostnames, or asks whether a path
// exists locally. That is deliberate and load-bearing: under `ssh localhost`
// both environments are the SAME machine with the same paths, so any check of
// that kind would look correct in every demo we can run and fail the first time
// Synara points at a real VPS. Keying on environment id alone means the
// same-machine case proves the same thing a genuinely remote one would.
//
// LONGEST PREFIX, not first match: a worktree nested under a project root must
// resolve to the WORKTREE's owner, which is the more specific claim.

import type { EnvironmentId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { orderedEnvironmentEntriesForPathIndex } from "./storeAggregation";
import type { AppState } from "./storeState";

/**
 * Where a path lives.
 *
 * Three states, never a bare id, so "we do not know" is a value the caller MUST
 * handle rather than something that decays into "local". A two-state resolver
 * would have made the unknown case indistinguishable from a confident local
 * answer, which is exactly the silent wrong-checkout write this exists to stop.
 */
export type PathEnvironmentResolution =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly environmentId: EnvironmentId }
  | { readonly kind: "unknown"; readonly path: string };

export interface PathOwnershipEntry {
  /** Normalized absolute path prefix. */
  readonly prefix: string;
  readonly environmentId: EnvironmentId;
}

/**
 * Trailing separators removed so `/srv/app/` and `/srv/app` are one prefix.
 *
 * Case and unicode are left exactly as reported. Normalizing case would make
 * two genuinely different paths on a case-sensitive filesystem collide, and the
 * server that reported the path is the authority on how it is spelled.
 */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

/**
 * Whether `path` is `prefix` itself or lives beneath it.
 *
 * The separator check is what keeps `/srv/app-2` from matching the prefix
 * `/srv/app`: a plain `startsWith` would hand one project's sibling directory
 * to the other project's host.
 */
function isWithin(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  const next = path.charAt(prefix.length);
  return next === "/" || next === "\\";
}

/**
 * Every path prefix the store knows about, with its owning environment.
 *
 * Built from both sources because they answer different questions: project
 * `cwd` covers the whole checkout, and thread `worktreePath` covers worktrees
 * that may sit outside any project root — or nested inside one belonging to a
 * different host.
 */
export function buildPathOwnershipIndex(state: AppState): readonly PathOwnershipEntry[] {
  const entries: PathOwnershipEntry[] = [];
  for (const [environmentId, environment] of orderedEnvironmentEntriesForPathIndex(state)) {
    for (const project of environment.projects) {
      const prefix = normalizePath(project.cwd);
      if (prefix.length > 0) {
        entries.push({ prefix, environmentId: environmentId as EnvironmentId });
      }
    }
    for (const shell of Object.values(environment.threadShellById ?? {})) {
      const worktreePath = shell?.worktreePath;
      if (typeof worktreePath !== "string") continue;
      const prefix = normalizePath(worktreePath);
      if (prefix.length > 0) {
        entries.push({ prefix, environmentId: environmentId as EnvironmentId });
      }
    }
  }
  return entries;
}

/**
 * The environment owning `path`, by longest matching prefix.
 *
 * Ties go to the first entry in aggregate order, the same precedence
 * `environmentIdForThread` uses — so when two hosts legitimately report the
 * same path (the `ssh localhost` case, or two clones at matching paths), the
 * host whose rows are on screen is the host that gets written to.
 */
export function findPathEnvironmentId(
  index: readonly PathOwnershipEntry[],
  path: string,
): EnvironmentId | null {
  const target = normalizePath(path);
  if (target.length === 0) return null;
  let best: PathOwnershipEntry | null = null;
  for (const entry of index) {
    if (!isWithin(target, entry.prefix)) continue;
    if (best === null || entry.prefix.length > best.prefix.length) {
      best = entry;
    }
  }
  return best?.environmentId ?? null;
}

/**
 * Whether any REMOTE environment is registered.
 *
 * The switch that decides what an unknown path means. With no remote host a
 * path can only be local, so "unknown" is not genuinely ambiguous and must not
 * become a new refusal — a local-only user has to stay bit-identical to today,
 * with no migration and nothing new to click.
 */
export function hasRemoteEnvironment(state: AppState): boolean {
  return Object.keys(state.environmentById).some(
    (environmentId) => environmentId !== LOCAL_ENVIRONMENT_ID,
  );
}

/**
 * Resolves a bare `cwd` to the host that owns it.
 *
 * `unknown` is returned ONLY when a remote environment is registered; with just
 * the local server an unmatched path is `local`, because it cannot be anything
 * else. Once two machines are in play the path is genuinely ambiguous, and the
 * caller must refuse: a silent wrong-checkout write is unrecoverable, while a
 * refusal costs a click.
 */
export function resolvePathEnvironment(
  state: AppState,
  path: string | null | undefined,
): PathEnvironmentResolution {
  if (typeof path !== "string" || path.trim().length === 0) {
    // No path at all is not ambiguous — there is nothing to send elsewhere.
    return { kind: "local" };
  }
  const owner = findPathEnvironmentId(buildPathOwnershipIndex(state), path);
  if (owner !== null) {
    return owner === LOCAL_ENVIRONMENT_ID
      ? { kind: "local" }
      : { kind: "remote", environmentId: owner };
  }
  if (!hasRemoteEnvironment(state)) return { kind: "local" };
  return { kind: "unknown", path: normalizePath(path) };
}

/**
 * Message for a path no host claims while more than one host is connected.
 *
 * Names the path, because the user is the only one who can say which machine
 * they meant, and a refusal they cannot act on is just an obstacle.
 */
export function unknownPathRefusalMessage(path: string): string {
  return `Synara cannot tell which host ${path} belongs to. That path is not inside any folder a connected host has reported, and with more than one host connected, running this on the wrong machine could change the wrong files. Open the folder from the host it lives on, then try again.`;
}

export class UnknownPathEnvironmentError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(unknownPathRefusalMessage(path));
    this.name = "UnknownPathEnvironmentError";
    this.path = path;
  }
}

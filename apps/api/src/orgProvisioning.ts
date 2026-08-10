// FILE: orgProvisioning.ts
// Purpose: Resolve the organizations a user belongs to, provisioning a
// personal one the first time they sign in. Organizations are the unit of host
// ownership, so every authorized request needs this answer and most requests
// need it more than once — hence the short-lived cache.
// Layer: API identity
// Depends on: workos.ts (the WorkOS calls, injected as plain functions).

import { WorkosApiError, type WorkosOrganization } from "./workos";

/**
 * How long a membership list is reused before WorkOS is asked again. Long
 * enough that a burst of requests costs one round trip, short enough that
 * being added to or removed from an organization takes effect on its own
 * without anyone restarting the process.
 */
const CACHE_TTL_MS = 60_000;

/**
 * The WorkOS surface this module needs, as functions rather than the whole
 * client: it makes the three calls it depends on obvious, and lets tests stage
 * a race without standing up HTTP.
 */
export type OrgProvisioningDeps = {
  listUserOrganizationMemberships(userId: string): Promise<WorkosOrganization[]>;
  createOrganization(name: string): Promise<WorkosOrganization>;
  createOrganizationMembership(orgId: string, userId: string): Promise<void>;
  /** Injectable clock, so the TTL can be tested without waiting a minute. */
  now?: () => number;
};

type CacheEntry = {
  memberships: WorkosOrganization[];
  fetchedAt: number;
};

/**
 * Per process, not per request: the point is to survive across the several
 * requests a single CLI command makes. A restart or a deploy simply refills
 * it, and nothing here is authoritative — WorkOS is.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Provisioning runs in flight per user, so concurrent org-less requests from
 * one user share a single attempt rather than each creating an organization.
 * WorkOS only refuses a duplicate *membership*, never a duplicate
 * organization, so without this the loser of the race leaves a stray empty
 * workspace behind and the user sees two.
 *
 * Known accepted limitation, alongside the cache being per process: this
 * closes the window within one instance only. Two instances can still both
 * create, and the conflict recovery below is what keeps that merely untidy
 * rather than broken. V1 runs single-instance; a durable claim (a unique row
 * keyed by user id) is what a multi-instance deployment would need.
 */
const provisioningInFlight = new Map<string, Promise<WorkosOrganization[]>>();

/** Drops every cached membership list. Exported for tests. */
export function clearOrgCache(): void {
  cache.clear();
  provisioningInFlight.clear();
}

/**
 * Drops every cached membership list that mentions `orgId`.
 *
 * Memberships carry the organization *name*, so this cache is also a name
 * cache — and a rename that did not evict it would keep serving the old
 * workspace name to every member for the rest of the TTL, including to the
 * user who just performed the rename and is watching for it to take effect.
 *
 * Every member is evicted, not just the caller: the rename is visible to all
 * of them, and scanning a per-process map of at most a few thousand entries is
 * cheaper than the confusion of a workspace that is renamed for one person.
 */
export function invalidateOrgCacheForOrganization(orgId: string): void {
  for (const [userId, entry] of cache) {
    if (entry.memberships.some((membership) => membership.orgId === orgId)) {
      cache.delete(userId);
    }
  }
}

/** What a user's own workspace is called when this service creates it. */
export function personalOrgName(email: string): string {
  return `Personal — ${email}`;
}

function isConflict(error: unknown): boolean {
  // 409 is the documented duplicate; 422 covers WorkOS answering an
  // already-satisfied membership as unprocessable rather than conflicting.
  return error instanceof WorkosApiError && (error.status === 409 || error.status === 422);
}

async function readMemberships(
  deps: OrgProvisioningDeps,
  userId: string,
  clock: () => number,
): Promise<WorkosOrganization[]> {
  const memberships = await deps.listUserOrganizationMemberships(userId);
  cache.set(userId, { memberships, fetchedAt: clock() });
  return memberships;
}

/**
 * Creates the personal organization and joins the user to it. Only ever called
 * through the single-flight below, which is what makes the re-read at the top
 * meaningful: by the time a queued caller runs, the winner has already
 * provisioned, and this returns that result instead of creating a second one.
 */
async function provisionPersonalOrg(
  deps: OrgProvisioningDeps,
  userId: string,
  email: string,
  clock: () => number,
): Promise<WorkosOrganization[]> {
  // Read again on the way in, not just before entering the single-flight: it
  // costs one request and it shrinks the cross-process window to the gap
  // between this read and the create.
  const existing = await readMemberships(deps, userId, clock);
  if (existing.length > 0) return existing;

  const organization = await deps.createOrganization(personalOrgName(email));
  try {
    await deps.createOrganizationMembership(organization.orgId, userId);
  } catch (error) {
    if (!isConflict(error)) throw error;
    // Another instance got there first — believe the list, not this error.
    const afterRace = await readMemberships(deps, userId, clock);
    if (afterRace.length === 0) throw error;
    return afterRace;
  }

  // Re-read rather than returning the organization just created: WorkOS is the
  // authority on membership, and a create that somehow did not take must not
  // be reported as one that did.
  return readMemberships(deps, userId, clock);
}

/**
 * The organizations `userId` belongs to, creating a personal one if they
 * belong to none. Every user therefore has a workspace from their first
 * sign-in, and a team later is the same organization with more members — no
 * migration, and no separate "personal account" concept to unpick.
 *
 * Concurrent org-less requests from one user share a single provisioning
 * attempt, so they cannot each create an organization. Across instances the
 * race is still possible; WorkOS refuses the loser's membership with a
 * conflict, which is treated as success-by-someone-else — the list is re-read
 * and whatever is actually there is returned. The cost of that race is a stray
 * empty organization, not a failed request.
 */
export async function ensurePersonalOrg(
  deps: OrgProvisioningDeps,
  userId: string,
  email: string,
): Promise<WorkosOrganization[]> {
  const clock = deps.now ?? Date.now;

  const cached = cache.get(userId);
  if (cached && clock() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.memberships;
  }

  const inFlight = provisioningInFlight.get(userId);
  if (inFlight) return inFlight;

  const pending = provisionPersonalOrg(deps, userId, email, clock);
  provisioningInFlight.set(userId, pending);
  try {
    return await pending;
  } catch (error) {
    // The read that preceded the failure cached "no organizations". Keeping it
    // would serve that answer for the rest of the TTL and suppress the retry
    // that would have provisioned properly.
    cache.delete(userId);
    throw error;
  } finally {
    // Evicted on failure as well as success: a single failed attempt must not
    // become the permanent answer for this user.
    if (provisioningInFlight.get(userId) === pending) provisioningInFlight.delete(userId);
  }
}

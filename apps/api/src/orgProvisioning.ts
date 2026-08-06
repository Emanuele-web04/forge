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

/** Drops every cached membership list. Exported for tests. */
export function clearOrgCache(): void {
  cache.clear();
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
 * The organizations `userId` belongs to, creating a personal one if they
 * belong to none. Every user therefore has a workspace from their first
 * sign-in, and a team later is the same organization with more members — no
 * migration, and no separate "personal account" concept to unpick.
 *
 * Provisioning is racy by nature: two requests from one user can both observe
 * an empty list. WorkOS refuses the loser's membership with a conflict, which
 * is treated as success-by-someone-else — the list is re-read and whatever is
 * actually there is returned. The cost of the race is a stray empty
 * organization, not a failed request.
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

  const existing = await readMemberships(deps, userId, clock);
  if (existing.length > 0) return existing;

  const organization = await deps.createOrganization(personalOrgName(email));
  try {
    await deps.createOrganizationMembership(organization.orgId, userId);
  } catch (error) {
    if (!isConflict(error)) throw error;
    // Someone else got there first — believe the list, not this error.
    const afterRace = await readMemberships(deps, userId, clock);
    if (afterRace.length === 0) throw error;
    return afterRace;
  }

  // Re-read rather than returning the organization just created: WorkOS is the
  // authority on membership, and a create that somehow did not take must not
  // be reported as one that did.
  return readMemberships(deps, userId, clock);
}

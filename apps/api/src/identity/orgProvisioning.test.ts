import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearOrgCache,
  ensurePersonalOrg,
  personalOrgName,
  type OrgProvisioningDeps,
} from "./orgProvisioning";
import { IdentityProviderError, type OrganizationRef } from "./interfaces";

/**
 * A WorkOS stand-in narrow enough to stage races and failures directly. The
 * HTTP-level double lives in testing/fakeWorkos.ts; what matters here is call
 * counts and ordering, which are easier to see than to reconstruct from
 * request logs.
 */
function makeDeps(overrides: Partial<OrgProvisioningDeps> = {}): OrgProvisioningDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  const state: OrganizationRef[] = [];

  const defaults: OrgProvisioningDeps = {
    listUserOrganizationMemberships: () => Promise.resolve([...state]),
    createOrganization: (name: string) => {
      const organization = { orgId: `org_${state.length + 1}`, orgName: name };
      state.push(organization);
      return Promise.resolve(organization);
    },
    createOrganizationMembership: () => Promise.resolve(),
  };

  // Recording wraps the resolved implementation rather than the default, so an
  // override still shows up in `calls`. Wrapping the other way round is the
  // obvious mistake: every call-count assertion would then read zero.
  const resolved = { ...defaults, ...overrides };
  return {
    calls,
    ...(overrides.now ? { now: overrides.now } : {}),
    listUserOrganizationMemberships(userId: string) {
      calls.push(`list:${userId}`);
      return resolved.listUserOrganizationMemberships(userId);
    },
    createOrganization(name: string) {
      calls.push(`create:${name}`);
      return resolved.createOrganization(name);
    },
    createOrganizationMembership(orgId: string, userId: string) {
      calls.push(`member:${orgId}:${userId}`);
      return resolved.createOrganizationMembership(orgId, userId);
    },
  };
}

beforeEach(() => {
  clearOrgCache();
});

afterEach(() => {
  clearOrgCache();
});

describe("ensurePersonalOrg", () => {
  it("returns existing memberships without creating anything", async () => {
    const existing: OrganizationRef[] = [{ orgId: "org_a", orgName: "Acme" }];
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([...existing]),
    });

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).resolves.toEqual(existing);
    expect(deps.calls.filter((call) => call.startsWith("create:"))).toEqual([]);
  });

  it("provisions a personal organization for a user who has none", async () => {
    const deps = makeDeps();

    const memberships = await ensurePersonalOrg(deps, "user_1", "ada@example.com");

    expect(memberships).toEqual([{ orgId: "org_1", orgName: personalOrgName("ada@example.com") }]);
    // Create, then join, then re-read: the membership list is authoritative,
    // so the result must come from WorkOS rather than be assembled locally.
    expect(deps.calls).toEqual([
      "list:user_1",
      `create:${personalOrgName("ada@example.com")}`,
      "member:org_1:user_1",
      "list:user_1",
    ]);
  });

  it("names the personal organization after the user's email", () => {
    expect(personalOrgName("ada@example.com")).toContain("ada@example.com");
  });

  /**
   * Two requests from the same user can provision concurrently — a CLI login
   * racing a status command, say. WorkOS refuses the second membership with a
   * conflict; treating that as fatal would fail a request whose work is
   * already done by the winner.
   */
  it("recovers from a membership conflict by re-reading the list", async () => {
    const created: OrganizationRef[] = [];
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([...created]),
      createOrganization: (name: string) => Promise.resolve({ orgId: "org_race", orgName: name }),
      createOrganizationMembership: () => {
        // The racing request won and already joined this user.
        created.push({ orgId: "org_winner", orgName: "Winner" });
        return Promise.reject(new IdentityProviderError(409, "Membership already exists"));
      },
    });

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).resolves.toEqual([
      { orgId: "org_winner", orgName: "Winner" },
    ]);
  });

  // A conflict the re-read does not explain is a real failure. Returning an
  // empty list would present it as "you belong to nothing", which reads to the
  // user as a permissions problem rather than an outage.
  it("rethrows a conflict when the re-read still finds no membership", async () => {
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([]),
      createOrganizationMembership: () =>
        Promise.reject(new IdentityProviderError(409, "Membership already exists")),
    });

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).rejects.toMatchObject({
      status: 409,
    });
  });

  /**
   * The conflict recovery above is the cross-process safety net; within one
   * process the race must not happen at all. WorkOS only refuses a duplicate
   * *membership*, so two concurrent creates would leave a stray empty
   * organization behind and hand the loser a workspace nobody asked for.
   */
  it("creates one organization when two requests for the same user race", async () => {
    const created: OrganizationRef[] = [];
    let release!: () => void;
    const listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCount = 0;

    const deps = makeDeps({
      // The first read is held open until both callers have arrived, which is
      // the window a per-user single-flight has to close.
      listUserOrganizationMemberships: async () => {
        listCount += 1;
        if (listCount === 1) await listGate;
        return [...created];
      },
      createOrganization: (name: string) => {
        const organization = { orgId: `org_${created.length + 1}`, orgName: name };
        created.push(organization);
        return Promise.resolve(organization);
      },
    });

    const first = ensurePersonalOrg(deps, "user_1", "ada@example.com");
    const second = ensurePersonalOrg(deps, "user_1", "ada@example.com");
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(deps.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(a).toEqual(b);
  });

  // The single-flight entry must be evicted on rejection too, or one failed
  // provisioning would keep answering every later request with the same error.
  it("retries provisioning after a failed attempt settles", async () => {
    let attempt = 0;
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([]),
      createOrganization: (name: string) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new IdentityProviderError(500, "WorkOS is down"));
        return Promise.resolve({ orgId: "org_second", orgName: name });
      },
    });

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).rejects.toMatchObject({
      status: 500,
    });
    await ensurePersonalOrg(deps, "user_1", "ada@example.com");

    expect(attempt).toBe(2);
  });

  it("propagates a failure to create the organization", async () => {
    const deps = makeDeps({
      createOrganization: () => Promise.reject(new IdentityProviderError(500, "WorkOS is down")),
    });

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("membership cache", () => {
  it("serves a repeat lookup from cache instead of calling WorkOS again", async () => {
    const deps = makeDeps({
      listUserOrganizationMemberships: (userId: string) => {
        return Promise.resolve([{ orgId: "org_a", orgName: `Acme ${userId}` }]);
      },
    });

    await ensurePersonalOrg(deps, "user_1", "ada@example.com");
    const listsAfterFirst = deps.calls.filter((call) => call.startsWith("list:")).length;
    await ensurePersonalOrg(deps, "user_1", "ada@example.com");

    expect(deps.calls.filter((call) => call.startsWith("list:"))).toHaveLength(listsAfterFirst);
  });

  it("caches per user rather than globally", async () => {
    const deps = makeDeps({
      listUserOrganizationMemberships: (userId: string) =>
        Promise.resolve([{ orgId: `org_${userId}`, orgName: userId }]),
    });

    await expect(ensurePersonalOrg(deps, "user_1", "a@example.com")).resolves.toEqual([
      { orgId: "org_user_1", orgName: "user_1" },
    ]);
    await expect(ensurePersonalOrg(deps, "user_2", "b@example.com")).resolves.toEqual([
      { orgId: "org_user_2", orgName: "user_2" },
    ]);
  });

  it("re-reads once the entry has aged past its TTL", async () => {
    let now = 1_000_000;
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([{ orgId: "org_a", orgName: "Acme" }]),
      now: () => now,
    });

    await ensurePersonalOrg(deps, "user_1", "ada@example.com");
    now += 61_000;
    await ensurePersonalOrg(deps, "user_1", "ada@example.com");

    expect(deps.calls.filter((call) => call.startsWith("list:"))).toHaveLength(2);
  });

  /**
   * Provisioning must invalidate: the pre-provision read cached "no
   * organizations", and serving that afterwards would 403 the very request
   * that just created the workspace.
   */
  it("does not serve the pre-provision empty list from cache", async () => {
    const created: OrganizationRef[] = [];
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([...created]),
      createOrganization: (name: string) => {
        created.push({ orgId: "org_new", orgName: name });
        return Promise.resolve({ orgId: "org_new", orgName: name });
      },
    });

    await ensurePersonalOrg(deps, "user_1", "ada@example.com");

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).resolves.toEqual([
      { orgId: "org_new", orgName: personalOrgName("ada@example.com") },
    ]);
  });

  it("clearOrgCache forces the next lookup back to WorkOS", async () => {
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([{ orgId: "org_a", orgName: "Acme" }]),
    });

    await ensurePersonalOrg(deps, "user_1", "ada@example.com");
    clearOrgCache();
    await ensurePersonalOrg(deps, "user_1", "ada@example.com");

    expect(deps.calls.filter((call) => call.startsWith("list:"))).toHaveLength(2);
  });
});

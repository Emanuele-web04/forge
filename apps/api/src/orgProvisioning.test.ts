import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearOrgCache,
  ensurePersonalOrg,
  personalOrgName,
  type OrgProvisioningDeps,
} from "./orgProvisioning";
import { WorkosApiError, type WorkosOrganization } from "./workos";

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
  const state: WorkosOrganization[] = [];

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
    const existing: WorkosOrganization[] = [{ orgId: "org_a", orgName: "Acme" }];
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
    const created: WorkosOrganization[] = [];
    const deps = makeDeps({
      listUserOrganizationMemberships: () => Promise.resolve([...created]),
      createOrganization: (name: string) => Promise.resolve({ orgId: "org_race", orgName: name }),
      createOrganizationMembership: () => {
        // The racing request won and already joined this user.
        created.push({ orgId: "org_winner", orgName: "Winner" });
        return Promise.reject(new WorkosApiError(409, "Membership already exists"));
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
        Promise.reject(new WorkosApiError(409, "Membership already exists")),
    });

    await expect(ensurePersonalOrg(deps, "user_1", "ada@example.com")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("propagates a failure to create the organization", async () => {
    const deps = makeDeps({
      createOrganization: () => Promise.reject(new WorkosApiError(500, "WorkOS is down")),
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
    const created: WorkosOrganization[] = [];
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

// FILE: environmentPathRouting.test.ts
// Purpose: Proves a `cwd`-keyed call reaches the host whose checkout it means,
//          and refuses rather than guessing when no host claims the path.
// Layer: Web transport routing tests

import { EnvironmentId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildPathOwnershipIndex,
  findPathEnvironmentId,
  hasRemoteEnvironment,
  resolvePathEnvironment,
  unknownPathRefusalMessage,
} from "./environmentPathRouting";
import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import type { AppState } from "./storeState";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const OTHER_REMOTE_ID = EnvironmentId.makeUnsafe("bbbbbbbb-2222-4222-8222-222222222222");

interface EnvironmentFixture {
  readonly projects?: readonly string[];
  readonly worktrees?: readonly string[];
}

/**
 * A store holding only what path routing reads.
 *
 * Ownership is stated by putting a path INSIDE a host's record, because that is
 * the only way the real store can express it — there is no ownership field to
 * set, and no side table to disagree with.
 */
function state(environments: Readonly<Record<string, EnvironmentFixture>>): AppState {
  const environmentById: Record<string, unknown> = {};
  for (const [environmentId, fixture] of Object.entries(environments)) {
    environmentById[environmentId] = {
      projects: (fixture.projects ?? []).map((cwd, index) => ({
        id: `${environmentId}-project-${index}`,
        cwd,
      })),
      threadShellById: Object.fromEntries(
        (fixture.worktrees ?? []).map((worktreePath, index) => [
          ThreadId.makeUnsafe(`${environmentId}-thread-${index}`),
          { id: `${environmentId}-thread-${index}`, worktreePath },
        ]),
      ),
      threadsHydrated: true,
      spaces: [],
    };
  }
  return { environmentById } as unknown as AppState;
}

const LOCAL_ONLY = state({ [LOCAL_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app"] } });

const TWO_HOSTS = state({
  [LOCAL_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app"] },
  [REMOTE_ENVIRONMENT_ID]: { projects: ["/srv/service"] },
});

describe("the path ownership index", () => {
  it("indexes project roots and thread worktrees from each host's own record", () => {
    const index = buildPathOwnershipIndex(
      state({
        [REMOTE_ENVIRONMENT_ID]: {
          projects: ["/srv/service"],
          worktrees: ["/srv/worktrees/feature"],
        },
      }),
    );
    expect(index.map((entry) => entry.prefix).toSorted()).toEqual([
      "/srv/service",
      "/srv/worktrees/feature",
    ]);
    expect(index.every((entry) => entry.environmentId === REMOTE_ENVIRONMENT_ID)).toBe(true);
  });

  it("treats a trailing separator as the same prefix", () => {
    const index = buildPathOwnershipIndex(
      state({ [REMOTE_ENVIRONMENT_ID]: { projects: ["/srv/service/"] } }),
    );
    expect(findPathEnvironmentId(index, "/srv/service")).toBe(REMOTE_ENVIRONMENT_ID);
    expect(findPathEnvironmentId(index, "/srv/service/src/main.ts")).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("does not let a sibling directory match a prefix", () => {
    // `/srv/app-2` must not be handed to `/srv/app`'s host. A plain
    // `startsWith` would do exactly that, and the write would land in another
    // project's checkout.
    const index = buildPathOwnershipIndex(
      state({ [REMOTE_ENVIRONMENT_ID]: { projects: ["/srv/app"] } }),
    );
    expect(findPathEnvironmentId(index, "/srv/app-2/src")).toBeNull();
    expect(findPathEnvironmentId(index, "/srv/app/src")).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("prefers the LONGEST prefix so a nested worktree beats its parent project", () => {
    // A worktree nested under a project root belongs to the worktree's owner —
    // the more specific claim. First-match would send it to the parent's host.
    const index = buildPathOwnershipIndex(
      state({
        [LOCAL_ENVIRONMENT_ID]: { projects: ["/Users/me/dev"] },
        [REMOTE_ENVIRONMENT_ID]: { worktrees: ["/Users/me/dev/app/.worktrees/feature"] },
      }),
    );
    expect(findPathEnvironmentId(index, "/Users/me/dev/app/.worktrees/feature/src/x.ts")).toBe(
      REMOTE_ENVIRONMENT_ID,
    );
    expect(findPathEnvironmentId(index, "/Users/me/dev/other")).toBe(LOCAL_ENVIRONMENT_ID);
  });
});

describe("resolving a path with one host", () => {
  it("resolves a known project path to local", () => {
    expect(resolvePathEnvironment(LOCAL_ONLY, "/Users/me/dev/app/src")).toEqual({ kind: "local" });
  });

  it("resolves an UNKNOWN path to local when no remote host is registered", () => {
    // A local-only install must be bit-identical to today: no migration, no new
    // refusals. With one machine a path cannot be anywhere else.
    expect(resolvePathEnvironment(LOCAL_ONLY, "/tmp/somewhere-else")).toEqual({ kind: "local" });
    expect(hasRemoteEnvironment(LOCAL_ONLY)).toBe(false);
  });

  it("treats an absent path as local rather than ambiguous", () => {
    expect(resolvePathEnvironment(TWO_HOSTS, undefined)).toEqual({ kind: "local" });
    expect(resolvePathEnvironment(TWO_HOSTS, "   ")).toEqual({ kind: "local" });
  });
});

describe("resolving a path with two hosts", () => {
  it("routes a remote host's path to that host", () => {
    expect(resolvePathEnvironment(TWO_HOSTS, "/srv/service/src/main.ts")).toEqual({
      kind: "remote",
      environmentId: REMOTE_ENVIRONMENT_ID,
    });
  });

  it("keeps a local path local", () => {
    expect(resolvePathEnvironment(TWO_HOSTS, "/Users/me/dev/app/src")).toEqual({ kind: "local" });
  });

  it("REFUSES a path no host claims, naming it", () => {
    // The fail-closed half. With two machines in play the path is genuinely
    // ambiguous, and a silent wrong-checkout write is unrecoverable while a
    // refusal costs a click.
    const resolution = resolvePathEnvironment(TWO_HOSTS, "/tmp/scratch/notes");
    expect(resolution).toEqual({ kind: "unknown", path: "/tmp/scratch/notes" });
    expect(unknownPathRefusalMessage("/tmp/scratch/notes")).toContain("/tmp/scratch/notes");
  });
});

describe("when both hosts are the same machine", () => {
  /**
   * The `ssh localhost` shape: two registered environments that legitimately
   * report the SAME paths, because they really are one filesystem.
   *
   * This is the case the demo will actually exercise, and the reason nothing in
   * this module stats the filesystem or compares hostnames — a check of that
   * kind would look correct here and fail against a real VPS.
   */
  const SAME_MACHINE = state({
    [LOCAL_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app"] },
    [REMOTE_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app"] },
  });

  it("resolves an identical path to the host that owns the row on screen", () => {
    // Ties go to aggregate order, the same precedence thread and project
    // ownership use, so what the user sees and what they act on are one host.
    expect(resolvePathEnvironment(SAME_MACHINE, "/Users/me/dev/app/src")).toEqual({
      kind: "local",
    });
  });

  it("still REFUSES a path under NEITHER host", () => {
    // The negative half, and the one that protects the laptop. Identical
    // workspace roots must not make an unrelated path resolve to local by
    // accident — with a remote host registered it is ambiguous regardless of
    // how much the two hosts' paths overlap.
    expect(resolvePathEnvironment(SAME_MACHINE, "/tmp/unrelated")).toEqual({
      kind: "unknown",
      path: "/tmp/unrelated",
    });
  });

  it("routes to a remote host by path even when another host shares its root", () => {
    // Ownership is keyed on the environment record, never on whether the path
    // exists locally — which under `ssh localhost` it always does.
    const nested = state({
      [LOCAL_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app"] },
      [REMOTE_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app/service"] },
    });
    expect(resolvePathEnvironment(nested, "/Users/me/dev/app/service/src")).toEqual({
      kind: "remote",
      environmentId: REMOTE_ENVIRONMENT_ID,
    });
  });
});

describe("more than one remote host", () => {
  it("routes each path to its own host", () => {
    const three = state({
      [LOCAL_ENVIRONMENT_ID]: { projects: ["/Users/me/dev/app"] },
      [REMOTE_ENVIRONMENT_ID]: { projects: ["/srv/one"] },
      [OTHER_REMOTE_ID]: { projects: ["/srv/two"] },
    });
    expect(resolvePathEnvironment(three, "/srv/one/x")).toEqual({
      kind: "remote",
      environmentId: REMOTE_ENVIRONMENT_ID,
    });
    expect(resolvePathEnvironment(three, "/srv/two/x")).toEqual({
      kind: "remote",
      environmentId: OTHER_REMOTE_ID,
    });
  });
});

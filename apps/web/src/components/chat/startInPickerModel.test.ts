// FILE: startInPickerModel.test.ts
// Purpose: Proves the "Start in" picker can never offer one host's folders under
//          another host, refuses explicitly instead of substituting local, and
//          reports host readiness without over-claiming.
// Layer: Chat composer logic tests

import { EnvironmentId, ProjectId, type ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { EnvironmentDirectoryEntry } from "../../environmentDirectory";
import { LOCAL_ENVIRONMENT_ID } from "../../environmentIdentity";
import {
  buildStartInEnvironmentOptions,
  filterStartInOptions,
  resolveStartInReadiness,
  resolveStartInSelection,
  signInProviderName,
  startInReadinessNote,
  type StartInEnvironmentInput,
  type StartInProject,
} from "./startInPickerModel";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const LOCAL_PROJECT_ID = ProjectId.makeUnsafe("project-local");
const REMOTE_PROJECT_ID = ProjectId.makeUnsafe("project-remote");

const LOCAL_PROJECT: StartInProject = {
  id: LOCAL_PROJECT_ID,
  name: "laptop-app",
  cwd: "/Users/me/laptop-app",
};
const REMOTE_PROJECT: StartInProject = {
  id: REMOTE_PROJECT_ID,
  name: "vps-service",
  cwd: "/srv/vps-service",
};

function environment(
  overrides: Partial<EnvironmentDirectoryEntry> & Pick<EnvironmentDirectoryEntry, "environmentId">,
): EnvironmentDirectoryEntry {
  return {
    label: overrides.environmentId,
    isLocal: overrides.environmentId === LOCAL_ENVIRONMENT_ID,
    reachability: "reachable",
    wsUrl: null,
    descriptor: null,
    ...overrides,
  };
}

function providerStatus(overrides: Partial<ServerProviderStatus>): ServerProviderStatus {
  return {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  } as ServerProviderStatus;
}

const AUTHENTICATED = [providerStatus({})];

/**
 * The picker's input: each environment paired with the projects ITS OWN record
 * holds. Ownership is positional, so a test states it by putting the project
 * under a host — there is no ownership map to get wrong.
 */
function inputs(
  overrides: {
    readonly local?: Partial<StartInEnvironmentInput>;
    readonly remote?: Partial<StartInEnvironmentInput>;
  } = {},
): readonly StartInEnvironmentInput[] {
  return [
    {
      environment: environment({ environmentId: LOCAL_ENVIRONMENT_ID, label: "This computer" }),
      projects: [LOCAL_PROJECT],
      providerStatuses: AUTHENTICATED,
      ...overrides.local,
    },
    {
      environment: environment({
        environmentId: REMOTE_ENVIRONMENT_ID,
        label: "prod-vps",
        wsUrl: "wss://vps.example.com/ws",
      }),
      projects: [REMOTE_PROJECT],
      providerStatuses: AUTHENTICATED,
      ...overrides.remote,
    },
  ];
}

describe("building start-in options", () => {
  it("lists each environment with only its OWN projects", () => {
    const options = buildStartInEnvironmentOptions(inputs());

    const local = options.find((option) => option.isLocal);
    const remote = options.find((option) => !option.isLocal);
    expect(local?.projects.map((project) => project.id)).toEqual([LOCAL_PROJECT_ID]);
    expect(remote?.projects.map((project) => project.id)).toEqual([REMOTE_PROJECT_ID]);
  });

  it("shows an unreachable host but refuses to make it selectable", () => {
    const options = buildStartInEnvironmentOptions(
      inputs({
        remote: {
          environment: environment({
            environmentId: REMOTE_ENVIRONMENT_ID,
            reachability: "unreachable",
          }),
        },
      }),
    );
    const remote = options.find((option) => !option.isLocal);
    // Hiding it would look like the host was forgotten; enabling it would queue
    // a dispatch that cannot land.
    expect(remote).toBeDefined();
    expect(remote?.selectable).toBe(false);
    expect(remote?.disabledReason).toContain("Settings");
  });

  it("distinguishes 'still connecting' from 'unreachable'", () => {
    const options = buildStartInEnvironmentOptions([
      {
        environment: environment({
          environmentId: REMOTE_ENVIRONMENT_ID,
          reachability: "checking",
        }),
        projects: [REMOTE_PROJECT],
        providerStatuses: undefined,
      },
    ]);
    expect(options[0]?.selectable).toBe(false);
    expect(options[0]?.disabledReason).toBe("Connecting…");
  });
});

describe("host readiness", () => {
  it("is ready when at least one provider is available and signed in", () => {
    expect(resolveStartInReadiness(AUTHENTICATED)).toBe("ready");
  });

  it("reports not-authenticated only when a provider actually said so", () => {
    expect(resolveStartInReadiness([providerStatus({ authStatus: "unauthenticated" })])).toBe(
      "not-authenticated",
    );
  });

  it("treats a host that has not reported as unknown, never as signed out", () => {
    // The distinction that keeps the message trustworthy: a freshly connected
    // host is silent for as long as its first status push takes to arrive, and
    // accusing it of being signed out in that window trains the user to ignore
    // the line entirely.
    expect(resolveStartInReadiness(undefined)).toBe("unknown");
    expect(resolveStartInReadiness([])).toBe("unknown");
    expect(resolveStartInReadiness([providerStatus({ authStatus: "unknown" })])).toBe("unknown");
  });

  it("does not count a signed-in provider that is unavailable", () => {
    // Authenticated but not installed cannot run a turn, so claiming readiness
    // would send the user to a host that fails later, deep inside a turn.
    // It is also NOT a sign-in problem: telling the user to sign in on a host
    // whose agent is not installed sends them to do something that will not
    // help. Distinct state, distinct advice.
    expect(
      resolveStartInReadiness([providerStatus({ available: false, authStatus: "authenticated" })]),
    ).toBe("unavailable");
    expect(startInReadinessNote("unavailable")).toContain("installed");
  });

  it("blames authentication only for a provider that is actually installed", () => {
    // An uninstalled provider reporting `unauthenticated` says nothing useful —
    // it is not signed in because it is not there. An installed one saying the
    // same thing is the case a sign-in fixes.
    expect(
      resolveStartInReadiness([
        providerStatus({ available: false, authStatus: "unauthenticated" }),
      ]),
    ).toBe("unavailable");
    expect(
      resolveStartInReadiness([providerStatus({ available: true, authStatus: "unauthenticated" })]),
    ).toBe("not-authenticated");
  });

  describe("MIXED provider states", () => {
    // The case every earlier fixture missed: they were all single-provider or
    // uniform, so three states were pinned individually while their
    // COMBINATIONS went unexercised. A realistic host has one agent installed
    // and another absent, which makes mixed the common case rather than the
    // edge. Testing the distinctions I had just been thinking about, rather
    // than the space they live in, is what let a third wrong classification
    // through underneath a comment forbidding exactly that.
    const installedAuthed = providerStatus({ available: true, authStatus: "authenticated" });
    const installedUnauthed = providerStatus({ available: true, authStatus: "unauthenticated" });
    const installedUnknown = providerStatus({ available: true, authStatus: "unknown" });
    const absent = providerStatus({ available: false, authStatus: "unknown" });

    it("an installed+signed-in provider makes the host ready whatever else is absent", () => {
      expect(resolveStartInReadiness([installedAuthed, absent])).toBe("ready");
      expect(resolveStartInReadiness([absent, installedAuthed])).toBe("ready");
    });

    it("an absent provider does NOT make a still-checking host claim nothing is installed", () => {
      // The reported bug, exactly: this said "No coding agents are installed on
      // this host" while an agent WAS installed and merely mid-check.
      expect(resolveStartInReadiness([installedUnknown, absent])).toBe("unknown");
      expect(resolveStartInReadiness([absent, installedUnknown])).toBe("unknown");
    });

    it("an absent provider does not mask a real sign-in problem", () => {
      expect(resolveStartInReadiness([installedUnauthed, absent])).toBe("not-authenticated");
    });

    it("claims nothing is installed only when NOTHING is", () => {
      expect(resolveStartInReadiness([absent, absent])).toBe("unavailable");
    });

    it("is order-independent across every pairing", () => {
      // Order comes from the server's status list and is not guaranteed, so a
      // classifier that depends on it is wrong in a way no fixed fixture shows.
      const all = [installedAuthed, installedUnauthed, installedUnknown, absent];
      for (const left of all) {
        for (const right of all) {
          expect(resolveStartInReadiness([left, right])).toBe(
            resolveStartInReadiness([right, left]),
          );
        }
      }
    });
  });

  it("stays silent for a ready host and speaks for the others", () => {
    // Presence is the signal. A line that is always there is one nobody reads.
    expect(startInReadinessNote("ready")).toBeNull();
    expect(startInReadinessNote("not-authenticated")).toContain("sign in");
    expect(startInReadinessNote("unknown")).toContain("Checking");
  });

  it("names the provider to sign in to when exactly one is identifiable", () => {
    // A specific action beats a general one: "Sign in to Codex on this host"
    // tells the user where to go, "no providers are signed in" does not.
    expect(
      signInProviderName([providerStatus({ authStatus: "unauthenticated", authLabel: "Codex" })]),
    ).toBe("Codex");
    expect(startInReadinessNote("not-authenticated", "Codex")).toBe(
      "Sign in to Codex on this host to start chats here.",
    );
  });

  it("falls back to the provider kind when the server supplies no label", () => {
    expect(signInProviderName([providerStatus({ authStatus: "unauthenticated" })])).toBe("codex");
  });

  it("names NOTHING rather than guessing when several providers could be meant", () => {
    // Naming an arbitrary one sends the user to sign in to a provider they may
    // not want; naming the wrong one is worse than naming none.
    expect(
      signInProviderName([
        providerStatus({ provider: "codex", authStatus: "unauthenticated" }),
        providerStatus({ provider: "claudeAgent", authStatus: "unauthenticated" }),
      ]),
    ).toBeNull();
    expect(startInReadinessNote("not-authenticated", null)).toContain("No providers are signed in");
  });

  it("does not name an uninstalled provider", () => {
    // It is not signed in because it is not there; telling the user to sign in
    // to it sends them somewhere that cannot help.
    expect(
      signInProviderName([providerStatus({ available: false, authStatus: "unauthenticated" })]),
    ).toBeNull();
  });

  it("surfaces the readiness note on a reachable host that is not signed in", () => {
    const options = buildStartInEnvironmentOptions(
      inputs({ remote: { providerStatuses: [providerStatus({ authStatus: "unauthenticated" })] } }),
    );
    const remote = options.find((option) => !option.isLocal);
    expect(remote?.readiness).toBe("not-authenticated");
    // One identifiable provider, so the note names it: the specific action.
    expect(remote?.readinessNote).toBe("Sign in to codex on this host to start chats here.");
  });

  it("uses the unnamed line when several providers could be meant", () => {
    const options = buildStartInEnvironmentOptions(
      inputs({
        remote: {
          providerStatuses: [
            providerStatus({ provider: "codex", authStatus: "unauthenticated" }),
            providerStatus({ provider: "claudeAgent", authStatus: "unauthenticated" }),
          ],
        },
      }),
    );
    expect(options.find((option) => !option.isLocal)?.readinessNote).toContain(
      "No providers are signed in",
    );
  });

  it("does NOT block selection on readiness", () => {
    // Telling the user is the requirement; gating is a stronger claim. A host
    // they are about to authenticate is still a host they may pick.
    const options = buildStartInEnvironmentOptions(
      inputs({ remote: { providerStatuses: [providerStatus({ authStatus: "unauthenticated" })] } }),
    );
    expect(options.find((option) => !option.isLocal)?.selectable).toBe(true);
  });

  it("claims nothing about a host it cannot currently see", () => {
    // Stale statuses from before a disconnect are not evidence about now.
    const options = buildStartInEnvironmentOptions(
      inputs({
        remote: {
          environment: environment({
            environmentId: REMOTE_ENVIRONMENT_ID,
            reachability: "unreachable",
          }),
          providerStatuses: AUTHENTICATED,
        },
      }),
    );
    const remote = options.find((option) => !option.isLocal);
    expect(remote?.readiness).toBe("unknown");
    // `disabledReason` already owns that line with the more urgent fact.
    expect(remote?.readinessNote).toBeNull();
  });

  it("applies the same treatment to the local host", () => {
    // It would be odd to warn about a remote host while staying silent about a
    // local one in the same state.
    const options = buildStartInEnvironmentOptions(
      inputs({ local: { providerStatuses: [providerStatus({ authStatus: "unauthenticated" })] } }),
    );
    expect(options.find((option) => option.isLocal)?.readiness).toBe("not-authenticated");
  });
});

describe("resolving a selection", () => {
  const options = buildStartInEnvironmentOptions(inputs());
  const remote = options.find((option) => !option.isLocal) as (typeof options)[number];
  const local = options.find((option) => option.isLocal) as typeof remote;

  it("carries the chosen environment id alongside the project", () => {
    const result = resolveStartInSelection({ option: remote, projectId: REMOTE_PROJECT_ID });
    expect(result).toEqual({
      target: { environmentId: REMOTE_ENVIRONMENT_ID, projectId: REMOTE_PROJECT_ID },
    });
  });

  it("refuses a project that belongs to a different host instead of substituting local", () => {
    // The wrong-machine failure this exists to prevent: picking the laptop's
    // folder under the VPS would create a thread at a path the VPS lacks.
    const result = resolveStartInSelection({ option: remote, projectId: LOCAL_PROJECT_ID });
    expect(result).not.toHaveProperty("target");
    expect(result).toHaveProperty("refusal");
    if ("refusal" in result) {
      expect(result.refusal.description).toContain("prod-vps");
    }
  });

  it("refuses when the host is unreachable, naming the next action", () => {
    const unreachable = buildStartInEnvironmentOptions([
      {
        environment: environment({
          environmentId: REMOTE_ENVIRONMENT_ID,
          label: "prod-vps",
          reachability: "unreachable",
        }),
        projects: [REMOTE_PROJECT],
        providerStatuses: undefined,
      },
    ])[0];
    const result = resolveStartInSelection({
      option: unreachable as typeof remote,
      projectId: REMOTE_PROJECT_ID,
    });
    expect(result).toHaveProperty("refusal");
    if ("refusal" in result) {
      // Says what to do, not merely what failed.
      expect(result.refusal.description).toMatch(/ssh|Remote hosts/);
    }
  });

  it("still resolves a plain local selection", () => {
    expect(resolveStartInSelection({ option: local, projectId: LOCAL_PROJECT_ID })).toEqual({
      target: { environmentId: LOCAL_ENVIRONMENT_ID, projectId: LOCAL_PROJECT_ID },
    });
  });
});

describe("filtering", () => {
  const options = buildStartInEnvironmentOptions(inputs());

  it("keeps a whole environment when its label matches", () => {
    const filtered = filterStartInOptions(options, "prod");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.projects).toHaveLength(1);
  });

  it("narrows to matching projects without leaking them across environments", () => {
    const filtered = filterStartInOptions(options, "vps-service");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.environmentId).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("drops environments with no match at all", () => {
    expect(filterStartInOptions(options, "nothing-matches-this")).toHaveLength(0);
  });
});

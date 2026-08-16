// FILE: providerModelPrefetch.test.ts
// Purpose: Verifies new-thread model prefetch resolves providers/cwds, hits the
//          same React Query keys ChatView uses, warms every visible provider,
//          and gates Droid to explicit intent.
// Layer: Web lib tests

import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NEW_THREAD_MODEL_PREFETCH_PROVIDERS,
  NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  prefetchModelsForNewThread,
  prefetchProviderModelsForNewThread,
  providerModelsPrefetchQueryOptions,
  resolveNewThreadModelPrefetchCwd,
  resolveNewThreadModelPrefetchProvider,
  type ProviderModelPrefetchSettings,
} from "./providerModelPrefetch";
import { providerDiscoveryQueryKeys } from "./providerDiscoveryReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSettings(
  overrides: Partial<ProviderModelPrefetchSettings> = {},
): ProviderModelPrefetchSettings {
  return {
    defaultProvider: "codex",
    claudeBinaryPath: "",
    cursorBinaryPath: "",
    cursorApiEndpoint: "",
    antigravityBinaryPath: "",
    grokBinaryPath: "",
    deepSeekBinaryPath: "",
    droidBinaryPath: "",
    kiloBinaryPath: "",
    openCodeBinaryPath: "",
    piBinaryPath: "",
    piAgentDir: "",
    ...overrides,
  };
}

function makeStatus(provider: ProviderKind, available: boolean): ServerProviderStatus {
  return {
    provider,
    available,
    status: available ? "ready" : "error",
    authStatus: "authenticated",
    checkedAt: "2026-08-13T10:00:00.000Z",
    message: available ? undefined : `${provider} is not installed on this machine.`,
  };
}

function availableStatuses(unavailable: ReadonlyArray<ProviderKind>): ServerProviderStatus[] {
  return NEW_THREAD_MODEL_PREFETCH_PROVIDERS.map((provider) =>
    makeStatus(provider, !unavailable.includes(provider)),
  );
}

function modelKeysFromCalls(prefetchQuery: { mock: { calls: unknown[][] } }): unknown[][] {
  return prefetchQuery.mock.calls
    .map((call) => (call[0] as { queryKey?: unknown[] }).queryKey ?? [])
    .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
}

describe("resolveNewThreadModelPrefetchProvider", () => {
  it("prefers override, draft, sticky, project default, then app default", () => {
    expect(
      resolveNewThreadModelPrefetchProvider({
        providerOverride: "grok",
        draftActiveProvider: "cursor",
        stickyActiveProvider: "pi",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("grok");

    expect(
      resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: "cursor",
        stickyActiveProvider: "pi",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("cursor");

    expect(
      resolveNewThreadModelPrefetchProvider({
        stickyActiveProvider: null,
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("opencode");

    expect(
      resolveNewThreadModelPrefetchProvider({
        projectDefaultProvider: null,
        defaultProvider: "claudeAgent",
      }),
    ).toBe("claudeAgent");
  });
});

describe("resolveNewThreadModelPrefetchCwd", () => {
  it("prefers draft worktree, then project cwd, then server cwd", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        draftWorktreePath: "/tmp/worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/worktree");

    expect(
      resolveNewThreadModelPrefetchCwd({
        draftWorktreePath: null,
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/project");

    expect(
      resolveNewThreadModelPrefetchCwd({
        projectCwd: null,
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/server");
  });

  it("mirrors buildDraftThreadContextPatch: explicit worktree > fresh > local > draft", () => {
    const base = {
      draftWorktreePath: "/draft-wt",
      projectCwd: "/project",
      serverCwd: "/server",
    };
    const cases: Array<{
      input: Parameters<typeof resolveNewThreadModelPrefetchCwd>[0];
      expected: string | null;
    }> = [
      {
        input: { ...base, worktreePath: "/explicit", hasExplicitWorktreePath: true },
        expected: "/explicit",
      },
      {
        input: { ...base, worktreePath: null, hasExplicitWorktreePath: true },
        expected: "/project",
      },
      { input: { ...base, fresh: true }, expected: "/project" },
      { input: { ...base, envMode: "local" }, expected: "/project" },
      { input: { ...base, envMode: "worktree" }, expected: "/draft-wt" },
      {
        input: {
          ...base,
          worktreePath: "/explicit",
          hasExplicitWorktreePath: true,
          fresh: true,
          envMode: "local",
        },
        expected: "/explicit",
      },
    ];
    for (const { input, expected } of cases) {
      expect(resolveNewThreadModelPrefetchCwd(input)).toBe(expected);
    }
  });
});

describe("providerModelsPrefetchQueryOptions", () => {
  it("matches ChatView cache keys for cwd-scoped and binary-scoped providers", () => {
    const settings = makeSettings({
      claudeBinaryPath: "/bin/claude",
      cursorBinaryPath: "/bin/agent",
      cursorApiEndpoint: "https://api.example",
      antigravityBinaryPath: "/bin/antigravity",
      openCodeBinaryPath: "/bin/opencode",
      piBinaryPath: "/bin/pi",
      piAgentDir: "/tmp/pi-agent",
    });

    expect(
      providerModelsPrefetchQueryOptions({ provider: "claudeAgent", settings }).queryKey,
    ).toEqual(providerDiscoveryQueryKeys.models("claudeAgent", "/bin/claude", null, null, null));

    expect(providerModelsPrefetchQueryOptions({ provider: "cursor", settings }).queryKey).toEqual(
      providerDiscoveryQueryKeys.models("cursor", "/bin/agent", "https://api.example", null, null),
    );

    expect(
      providerModelsPrefetchQueryOptions({ provider: "opencode", settings, cwd: "/tmp/project" })
        .queryKey,
    ).toEqual(
      providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/tmp/project"),
    );

    expect(
      providerModelsPrefetchQueryOptions({ provider: "pi", settings, cwd: "/tmp/project" })
        .queryKey,
    ).toEqual(
      providerDiscoveryQueryKeys.models("pi", "/bin/pi", null, "/tmp/pi-agent", "/tmp/project"),
    );

    expect(providerModelsPrefetchQueryOptions({ provider: "codex", settings }).queryKey).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
  });
});

describe("prefetchModelsForNewThread", () => {
  it("warms every provider except Droid, selected provider first", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      projectCwd: "/tmp/project",
      projectDefaultProvider: "opencode",
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys[0]).toEqual(
      providerDiscoveryQueryKeys.models("opencode", null, null, null, "/tmp/project"),
    );
    // Warm results stay fresh for 30 minutes, so repeated hovers do not re-probe.
    expect(prefetchQuery.mock.calls[0]?.[0].staleTime).toBe(30 * 60_000);
    expect(modelKeys).toHaveLength(8);
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),
    );
    expect(modelKeys).toContainEqual(
      providerDiscoveryQueryKeys.models("claudeAgent", null, null, null, null),
    );
  });

  it("skips hidden and disabled providers", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      serverSettings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: false },
        },
      },
      hiddenProviders: ["pi"],
      projectCwd: "/tmp/project",
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys).toHaveLength(6);
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("cursor", null, null, null, "/tmp/project"),
    );
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("pi", null, null, null, "/tmp/project"),
    );
  });

  it("warms Droid only on explicit intent with Droid selected", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerOverride: "droid",
      projectCwd: "/tmp/project",
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),
    );

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerOverride: "droid",
      projectCwd: "/tmp/project",
      includeDroid: true,
    });

    const modelKeys2 = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys2).toContainEqual(
      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),
    );
  });

  it("warms the explicit providers subset without Droid", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchProviderModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providers: ["codex", "droid"],
    });

    const modelKeys = prefetchQuery.mock.calls
      .map((call) => call[0].queryKey)
      .filter((key) => key[0] === "provider-discovery" && key[1] === "models");
    expect(modelKeys).toHaveLength(1);
    expect(modelKeys[0]).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
  });
});

describe("prefetchModelsForNewThread — new-thread options key parity", () => {
  it("warms the prepared worktree cwd for the PR-handoff shape (worktreePath + fresh + local)", async () => {
    // PullRequestDetailPanel passes { worktreePath, envMode, fresh: true }; the
    // prepared worktree must win over the stored draft and envMode "local" clearing.
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings({ openCodeBinaryPath: "/bin/opencode" }),
      projectCwd: "/project",
      draftWorktreePath: "/old-draft-wt",
      worktreePath: "/prepared-wt",
      hasExplicitWorktreePath: true,
      fresh: true,
      envMode: "local",
    });

    const modelKeys = modelKeysFromCalls(prefetchQuery);
    expect(modelKeys).toContainEqual(
      providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/prepared-wt"),
    );
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/old-draft-wt"),
    );
  });
});

describe("prefetchModelsForNewThread — availability parity (#652)", () => {
  it("skips confirmed-unavailable providers only when reconciled, and mirrors ChatView's preference", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    // Reconciled + confirmed-unavailable cursor → skipped (8 - 1 = 7).
    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerStatuses: availableStatuses(["cursor"]),
      statusesReconciled: true,
      projectCwd: "/tmp/project",
    });
    let modelKeys = modelKeysFromCalls(prefetchQuery);
    expect(modelKeys).toHaveLength(7);
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("cursor", null, null, null, null),
    );

    // Unreconciled → safe default: warm everything (8), even confirmed-unavailable.
    prefetchQuery.mockClear();
    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerStatuses: availableStatuses(["cursor"]),
      statusesReconciled: false,
      projectCwd: "/tmp/project",
    });
    modelKeys = modelKeysFromCalls(prefetchQuery);
    expect(modelKeys).toHaveLength(8);

    // Preferred provider unavailable → warm leads with ChatView's swap target (codex).
    prefetchQuery.mockClear();
    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings({ defaultProvider: "cursor" }),
      providerStatuses: availableStatuses(["cursor"]),
      statusesReconciled: true,
      projectCwd: "/tmp/project",
    });
    modelKeys = modelKeysFromCalls(prefetchQuery);
    expect(modelKeys[0]).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );

    // Disabled beats selected (useProviderModelCatalog short-circuit parity).
    prefetchQuery.mockClear();
    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      serverSettings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: false },
        },
      },
      providerOverride: "cursor",
      providerStatuses: availableStatuses([]),
      statusesReconciled: true,
      projectCwd: "/tmp/project",
    });
    modelKeys = modelKeysFromCalls(prefetchQuery);
    expect(modelKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.models("cursor", null, null, null, null),
    );

    // Selected but unavailable → still warmed (ChatView discovers it on mount).
    prefetchQuery.mockClear();
    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      providerOverride: "cursor",
      providerStatuses: availableStatuses(NEW_THREAD_MODEL_PREFETCH_PROVIDERS),
      statusesReconciled: true,
      projectCwd: "/tmp/project",
    });
    modelKeys = modelKeysFromCalls(prefetchQuery);
    expect(modelKeys).toHaveLength(1);
  });
});

describe("prefetchModelsForNewThread — warm-option invariants", () => {
  it("applies retry: 0 and 30-minute gcTime to every warm call; capabilities once per provider; droid capabilities only on explicit intent", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings(),
      projectCwd: "/tmp/project",
    });

    const calls = prefetchQuery.mock.calls.map((call) => call[0]);
    // 8 models + 8 capabilities + 4 agents (claudeAgent, codex, kilo, opencode).
    expect(calls).toHaveLength(8 + 8 + 4);
    for (const options of calls) {
      expect(options.retry).toBe(0);
      expect(options.gcTime).toBe(NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS);
    }
    const capabilityKeys = calls
      .map((options) => options.queryKey)
      .filter((key) => key[1] === "composer-capabilities");
    expect(capabilityKeys).toHaveLength(NEW_THREAD_MODEL_PREFETCH_PROVIDERS.length);
    expect(capabilityKeys).not.toContainEqual(
      providerDiscoveryQueryKeys.composerCapabilities("droid"),
    );

    // Droid warms only on explicit intent, capabilities riding along exactly once.
    prefetchQuery.mockClear();
    prefetchModelsForNewThread(queryClient, {
      settings: makeSettings({ droidBinaryPath: "/bin/droid" }),
      providerOverride: "droid",
      projectCwd: "/tmp/project",
      includeDroid: true,
    });
    const droidKeys = prefetchQuery.mock.calls.map((call) => call[0].queryKey);
    expect(droidKeys).toContainEqual(
      providerDiscoveryQueryKeys.models("droid", "/bin/droid", null, null, "/tmp/project"),
    );
    expect(droidKeys).toContainEqual(providerDiscoveryQueryKeys.composerCapabilities("droid"));
  });
});

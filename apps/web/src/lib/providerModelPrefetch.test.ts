// FILE: providerModelPrefetch.test.ts
// Purpose: Verifies new-thread model prefetch resolves providers/cwds and hits
//          the same React Query keys ChatView uses for listModels.
// Layer: Web lib tests

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  ProviderProfileId,
  type ModelSlug,
  type ProviderKind,
} from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prefetchProviderModelsForNewThread,
  providerModelsPrefetchQueryOptions,
  resolveNewThreadModelPrefetchCwd,
  resolveNewThreadModelPrefetchProvider,
  resolveNewThreadModelPrefetchTarget,
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
    cursorBinaryPath: "",
    cursorApiEndpoint: "",
    antigravityBinaryPath: "",
    grokBinaryPath: "",
    droidBinaryPath: "",
    kiloBinaryPath: "",
    openCodeBinaryPath: "",
    piBinaryPath: "",
    piAgentDir: "",
    ...overrides,
  };
}

describe("resolveNewThreadModelPrefetchProvider", () => {
  it("prefers draft, then sticky, then project default, then app default", () => {
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
        draftActiveProvider: null,
        stickyActiveProvider: "pi",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("pi");

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

describe("resolveNewThreadModelPrefetchTarget", () => {
  const projectSelection = {
    provider: "codex",
    profileId: ProviderProfileId.makeUnsafe("project"),
    model: "project-model" as ModelSlug,
  } as const;
  const stickySelection = {
    provider: "codex",
    profileId: ProviderProfileId.makeUnsafe("sticky"),
    model: "sticky-model" as ModelSlug,
  } as const;
  const draftSelection = {
    provider: "codex",
    profileId: ProviderProfileId.makeUnsafe("draft"),
    model: "draft-model" as ModelSlug,
  } as const;

  it("resolves the selected provider profile with draft, sticky, then project precedence", () => {
    const common = {
      draftActiveProvider: "codex" as const,
      stickyActiveProvider: "codex" as const,
      projectDefaultModelSelection: projectSelection,
      defaultProvider: "claudeAgent" as const,
    };

    expect(
      resolveNewThreadModelPrefetchTarget({
        ...common,
        draftModelSelectionByProvider: { codex: draftSelection },
        stickyModelSelectionByProvider: { codex: stickySelection },
      }),
    ).toEqual({
      provider: "codex",
      modelSelection: draftSelection,
      targetExecutable: false,
    });
    expect(
      resolveNewThreadModelPrefetchTarget({
        ...common,
        stickyModelSelectionByProvider: { codex: stickySelection },
      }).modelSelection,
    ).toEqual(stickySelection);
    expect(resolveNewThreadModelPrefetchTarget(common).modelSelection).toEqual(projectSelection);
  });

  it("feeds an unsupported resolved profile into the prefetch fail-closed gate", () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);
    const target = resolveNewThreadModelPrefetchTarget({
      draftActiveProvider: "codex",
      defaultProvider: "claudeAgent",
      draftModelSelectionByProvider: { codex: draftSelection },
    });

    prefetchProviderModelsForNewThread(queryClient, {
      provider: target.provider,
      targetExecutable: target.targetExecutable,
      settings: makeSettings(),
      cwd: "/repo",
    });

    expect(prefetchQuery).not.toHaveBeenCalled();
  });

  it("treats a missing or default selection as executable", () => {
    expect(
      resolveNewThreadModelPrefetchTarget({
        defaultProvider: "codex",
      }).targetExecutable,
    ).toBe(true);
    expect(
      resolveNewThreadModelPrefetchTarget({
        draftActiveProvider: "codex",
        defaultProvider: "claudeAgent",
        draftModelSelectionByProvider: {
          codex: {
            provider: "codex",
            profileId: DEFAULT_PROVIDER_PROFILE_ID,
            model: "gpt-5.6-sol" as ModelSlug,
          },
        },
      }).targetExecutable,
    ).toBe(true);
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
});

describe("providerModelsPrefetchQueryOptions", () => {
  it("matches ChatView cache keys for cwd-scoped and binary-scoped providers", () => {
    const settings = makeSettings({
      cursorBinaryPath: "/bin/agent",
      cursorApiEndpoint: "https://api.example",
      antigravityBinaryPath: "/bin/antigravity",
      openCodeBinaryPath: "/bin/opencode",
      piBinaryPath: "/bin/pi",
      piAgentDir: "/tmp/pi-agent",
    });

    const cursorOptions = providerModelsPrefetchQueryOptions({
      provider: "cursor",
      settings,
    });
    expect(cursorOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("cursor", "/bin/agent", "https://api.example", null, null),
    );

    const openCodeOptions = providerModelsPrefetchQueryOptions({
      provider: "opencode",
      settings,
      cwd: "/tmp/project",
    });
    expect(openCodeOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("opencode", "/bin/opencode", null, null, "/tmp/project"),
    );

    const piOptions = providerModelsPrefetchQueryOptions({
      provider: "pi",
      settings,
      cwd: "/tmp/project",
    });
    expect(piOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("pi", "/bin/pi", null, "/tmp/pi-agent", "/tmp/project"),
    );

    const antigravityOptions = providerModelsPrefetchQueryOptions({
      provider: "antigravity",
      settings,
      cwd: "/tmp/project",
    });
    expect(antigravityOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models(
        "antigravity",
        "/bin/antigravity",
        null,
        null,
        "/tmp/project",
      ),
    );

    const codexOptions = providerModelsPrefetchQueryOptions({
      provider: "codex",
      settings,
    });
    expect(codexOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
  });
});

describe("prefetchProviderModelsForNewThread", () => {
  it("prefetches models and agents for the resolved provider", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchProviderModelsForNewThread(queryClient, {
      provider: "kilo" satisfies ProviderKind,
      targetExecutable: true,
      settings: makeSettings({
        kiloBinaryPath: "/bin/kilo",
      }),
      cwd: "/tmp/project",
    });

    expect(prefetchQuery).toHaveBeenCalledTimes(3);
    expect(prefetchQuery.mock.calls[0]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.models("kilo", "/bin/kilo", null, null, "/tmp/project"),
    );
    expect(prefetchQuery.mock.calls[1]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.agents("kilo", "/bin/kilo", "/tmp/project"),
    );
    expect(prefetchQuery.mock.calls[2]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.composerCapabilities("kilo"),
    );
  });

  it("prefetches only models for providers without agent discovery", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchProviderModelsForNewThread(queryClient, {
      provider: "cursor",
      targetExecutable: true,
      settings: makeSettings({ cursorBinaryPath: "/bin/agent" }),
    });

    expect(prefetchQuery).toHaveBeenCalledTimes(2);
    expect(prefetchQuery.mock.calls[0]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.models("cursor", "/bin/agent", null, null, null),
    );
    expect(prefetchQuery.mock.calls[1]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.composerCapabilities("cursor"),
    );
  });

  it("does not prefetch through the default account for an unavailable target", () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchProviderModelsForNewThread(queryClient, {
      provider: "codex",
      targetExecutable: false,
      settings: makeSettings(),
    });

    expect(prefetchQuery).not.toHaveBeenCalled();
  });
});

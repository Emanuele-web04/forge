// FILE: providerModelPrefetch.test.ts
// Purpose: Verifies new-thread model prefetch resolves providers/cwds and hits
//          the same React Query keys ChatView uses for listModels.
// Layer: Web lib tests

import type { ProviderKind } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
    cursorBinaryPath: "",
    cursorApiEndpoint: "",
    antigravityBinaryPath: "",
    grokBinaryPath: "",
    droidBinaryPath: "",
    kiloBinaryPath: "",
    openCodeBinaryPath: "",
    commandCodeBinaryPath: "",
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
});

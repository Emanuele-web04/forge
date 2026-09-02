// FILE: useProviderModelCatalog.test.tsx
// Purpose: Locks the shared provider-model catalog's memoization and discovery policy.
// Layer: Web hook tests

import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderKind,
  type ProviderModelDescriptor,
} from "@synara/contracts";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderModelCatalog } from "./useProviderModelCatalog";
import {
  deriveProviderModelDiscoveryState,
  useProviderModelCatalog,
} from "./useProviderModelCatalog";

const mocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: mocks.useQuery };
});

vi.mock("../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appSettings")>();
  return { ...actual, useAppSettings: mocks.useAppSettings };
});

interface QueryOptionsLike {
  readonly queryKey: readonly unknown[];
  readonly enabled?: boolean;
}

interface QueryResultLike {
  readonly data?: {
    readonly agents?: ReadonlyArray<{ name: string; displayName: string }>;
    readonly cached?: boolean;
    readonly models?: ReadonlyArray<ProviderModelDescriptor>;
    readonly source?: string;
  };
  readonly dataUpdatedAt?: number;
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly isPlaceholderData: boolean;
  readonly status?: "error" | "pending" | "success";
}

const EMPTY_QUERY: QueryResultLike = {
  data: { models: [], source: "empty", cached: false },
  dataUpdatedAt: 0,
  isFetching: false,
  isLoading: false,
  isPlaceholderData: false,
  status: "pending",
};
const modelQueries = new Map<ProviderKind, QueryResultLike>();
const agentQueries = new Map<ProviderKind, QueryResultLike>();
const MODEL_HINTS = { cursor: "composer-2" } as const;
const SETTINGS = {
  antigravityBinaryPath: "",
  cursorApiEndpoint: "",
  cursorBinaryPath: "",
  customAntigravityModels: [],
  customClaudeModels: [],
  customCodexModels: [],
  customCursorModels: ["cursor-custom"],
  customDroidModels: [],
  customDevinModels: [],
  customGrokModels: [],
  customOpenCodeModels: [],
  customPiModels: [],
  droidBinaryPath: "",
  devinBinaryPath: "",
  grokBinaryPath: "",
  hiddenProviders: [],
  openCodeBinaryPath: "",
  piAgentDir: "",
  piBinaryPath: "",
};

function readCatalogRenders(
  input: Parameters<typeof useProviderModelCatalog>[0],
): ProviderModelCatalog[] {
  const results: ProviderModelCatalog[] = [];

  function Probe() {
    const [renderIndex, setRenderIndex] = useState(0);
    results.push(useProviderModelCatalog(input));
    if (renderIndex === 0) {
      setRenderIndex(1);
    }
    return null;
  }

  renderToStaticMarkup(<Probe />);
  expect(results).toHaveLength(2);
  return results;
}

function readAgentQueryEnabled(provider: ProviderKind): boolean | undefined {
  const call = mocks.useQuery.mock.calls.find(([value]) => {
    const queryKey = (value as QueryOptionsLike).queryKey;
    return queryKey[1] === "agents" && queryKey[2] === provider;
  });
  return call ? (call[0] as QueryOptionsLike).enabled : undefined;
}

function readModelQueryEnabled(provider: ProviderKind): boolean | undefined {
  const call = mocks.useQuery.mock.calls.find(([value]) => {
    const queryKey = (value as QueryOptionsLike).queryKey;
    return queryKey[1] === "models" && queryKey[2] === provider;
  });
  return call ? (call[0] as QueryOptionsLike).enabled : undefined;
}

beforeEach(() => {
  modelQueries.clear();
  agentQueries.clear();
  mocks.useAppSettings
    .mockReset()
    .mockReturnValue({ settings: SETTINGS, serverSettings: DEFAULT_SERVER_SETTINGS });
  mocks.useQuery.mockReset().mockImplementation((value: QueryOptionsLike) => {
    const [, resource, provider] = value.queryKey;
    if (resource === "models") {
      return modelQueries.get(provider as ProviderKind) ?? EMPTY_QUERY;
    }
    if (resource === "agents") {
      return agentQueries.get(provider as ProviderKind) ?? EMPTY_QUERY;
    }
    throw new Error(`Unexpected provider catalog query: ${String(resource)}`);
  });
});

describe("useProviderModelCatalog", () => {
  it("keeps aggregate identities stable when inputs and query data are unchanged", () => {
    const [first, second] = readCatalogRenders({
      selectedProvider: "cursor",
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    });

    expect(second).toBe(first);
    expect(second?.customModelsByProvider).toBe(first?.customModelsByProvider);
    expect(second?.modelOptionsByProvider).toBe(first?.modelOptionsByProvider);
    expect(second?.modelDiscoveryByProvider).toBe(first?.modelDiscoveryByProvider);
    expect(second?.runtimeModelsByProvider).toBe(first?.runtimeModelsByProvider);
    expect(second?.selectedRuntimeAgents).toBe(first?.selectedRuntimeAgents);
  });

  it("discovers core agents only when selected unless eager-core is requested", () => {
    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: false });
    expect(readAgentQueryEnabled("claudeAgent")).toBe(false);
    expect(readAgentQueryEnabled("codex")).toBe(false);

    mocks.useQuery.mockClear();
    readCatalogRenders({
      selectedProvider: "cursor",
      discoveryEnabled: false,
      agentDiscoveryPolicy: "eager-core",
    });
    expect(readAgentQueryEnabled("claudeAgent")).toBe(true);
    expect(readAgentQueryEnabled("codex")).toBe(true);
  });

  it("does not prefetch providers hidden from picker surfaces", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, hiddenProviders: ["cursor"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });

    readCatalogRenders({ selectedProvider: "codex", discoveryEnabled: true });

    expect(readModelQueryEnabled("codex")).toBe(true);
    expect(readModelQueryEnabled("cursor")).toBe(false);
    expect(readModelQueryEnabled("antigravity")).toBe(true);
  });

  it("keeps an enabled selected provider discoverable when it is hidden", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, hiddenProviders: ["cursor"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });

    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: false });

    expect(readModelQueryEnabled("cursor")).toBe(true);
  });

  it("does not discover a disabled provider even when it is selected", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: SETTINGS,
      serverSettings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          cursor: {
            ...DEFAULT_SERVER_SETTINGS.providers.cursor,
            enabled: false,
          },
        },
      },
    });

    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: true });

    expect(readModelQueryEnabled("cursor")).toBe(false);
  });

  it("keeps discovering while the server settings are unavailable", () => {
    // `serverSettings` is undefined until the settings query resolves, and stays
    // undefined for good if it fails — the query never refetches on its own. Failing
    // closed here would blank every provider's model list, selected one included.
    mocks.useAppSettings.mockReturnValue({ settings: SETTINGS, serverSettings: undefined });

    readCatalogRenders({ selectedProvider: "claudeAgent", discoveryEnabled: true });

    expect(readModelQueryEnabled("claudeAgent")).toBe(true);
    expect(readModelQueryEnabled("codex")).toBe(true);
  });

  it("keeps discovering the selected provider when the settings omit it", () => {
    // A client talking to a server whose provider set it does not fully know must not
    // lose model discovery over the unknown key — and must not throw reading it.
    const { cursor: _cursor, ...providersWithoutCursor } = DEFAULT_SERVER_SETTINGS.providers;
    mocks.useAppSettings.mockReturnValue({
      settings: SETTINGS,
      serverSettings: { ...DEFAULT_SERVER_SETTINGS, providers: providersWithoutCursor },
    });

    readCatalogRenders({ selectedProvider: "cursor", discoveryEnabled: false });

    expect(readModelQueryEnabled("cursor")).toBe(true);
  });

  it("restricts non-picker prefetch to the requested providers", () => {
    readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: true,
      prefetchProviders: ["codex", "opencode"],
    });

    expect(readModelQueryEnabled("codex")).toBe(true);
    expect(readModelQueryEnabled("opencode")).toBe(true);
    expect(readModelQueryEnabled("cursor")).toBe(false);
    expect(readModelQueryEnabled("antigravity")).toBe(false);
  });

  it("prefetches Droid discovery when a prefetch surface requests it", () => {
    // The git-writing settings panel passes GIT_TEXT_GENERATION_PROVIDERS, which
    // includes Droid; its ACP-session cost is bounded by the query's retry=0,
    // 5-minute staleTime, and disabled focus refetch.
    readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: true,
      prefetchProviders: ["codex", "droid"],
    });

    expect(readModelQueryEnabled("droid")).toBe(true);
  });

  it("merges a settled runtime catalog with custom models without reporting loading", () => {
    modelQueries.set("cursor", {
      data: {
        models: [{ slug: "composer-2", name: "Composer 2" }],
        source: "cursor.cli",
        cached: false,
      },
      dataUpdatedAt: 1_000,
      isFetching: true,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });

    const catalog = readCatalogRenders({
      selectedProvider: "cursor",
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    }).at(-1);

    expect(catalog?.modelOptionsByProvider.cursor.map((model) => model.slug)).toEqual([
      "composer-2",
      "cursor-custom",
    ]);
    expect(catalog?.selectedProviderRuntimeModelDiscoveryPending).toBe(false);
    expect(catalog?.runtimeModelsByProvider.cursor).toEqual([
      { slug: "composer-2", name: "Composer 2" },
    ]);
  });

  it("treats a selected GLM model as an unavailable hint after Devin discovery", () => {
    modelQueries.set("devin", {
      data: {
        models: [
          { slug: "adaptive", name: "Adaptive" },
          { slug: "swe-1.7", name: "SWE 1.7" },
        ],
        source: "devin-acp",
        cached: false,
      },
      dataUpdatedAt: 1_000,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });

    const catalog = readCatalogRenders({
      selectedProvider: "devin",
      discoveryEnabled: true,
      modelHintByProvider: { devin: "glm-5.3" },
    }).at(-1);

    expect(catalog?.modelOptionsByProvider.devin).toEqual([
      expect.objectContaining({ slug: "adaptive" }),
      expect.objectContaining({ slug: "swe-1-7" }),
      expect.objectContaining({ slug: "glm-5.3", isSelectionHint: true }),
    ]);
    expect(catalog?.modelDiscoveryByProvider.devin).toMatchObject({
      status: "success",
      hasDynamicList: true,
    });
  });

  it("exposes a truthful per-provider discovery state table", () => {
    const now = 1_000_000;
    modelQueries.set("opencode", {
      data: {
        models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        source: "opencode",
        cached: false,
      },
      dataUpdatedAt: now,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });

    const catalog = readCatalogRenders({
      selectedProvider: "opencode",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.modelDiscoveryByProvider.opencode).toMatchObject({
      status: "success",
      hasDynamicList: true,
      refreshing: false,
      fetchedAt: now,
    });
    // Non-discovery-owned providers stay in static-success so the picker falls through.
    expect(catalog?.modelDiscoveryByProvider.codex).toEqual({
      status: "success",
      hasDynamicList: false,
      refreshing: false,
    });
  });
});

describe("deriveProviderModelDiscoveryState", () => {
  const emptyResult = {
    models: [] as ProviderModelDescriptor[],
    source: "empty" as const,
    cached: false as const,
  };
  const realResult = {
    models: [{ slug: "x", name: "X" }] as ProviderModelDescriptor[],
    source: "opencode" as const,
    cached: false as const,
  };

  it("returns never-loaded when discovery has not run", () => {
    expect(
      deriveProviderModelDiscoveryState({
        data: undefined,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
        status: "pending",
      }),
    ).toEqual({ status: "never-loaded", hasDynamicList: false, refreshing: false });
  });

  it("returns loading for the initial fetch with no usable list", () => {
    expect(
      deriveProviderModelDiscoveryState({
        data: emptyResult,
        isFetching: true,
        isLoading: true,
        isPlaceholderData: true,
        status: "pending",
      }),
    ).toEqual({ status: "loading", hasDynamicList: false, refreshing: false });
  });

  it("keeps the failed row refreshing while a no-cache retry is in flight", () => {
    expect(
      deriveProviderModelDiscoveryState({
        data: emptyResult,
        errorUpdatedAt: 5_000,
        isFetching: true,
        isLoading: false,
        isPlaceholderData: true,
        status: "pending",
      }),
    ).toEqual({ status: "failed", hasDynamicList: false, refreshing: true });
  });

  it("returns success with a real dynamic list", () => {
    const state = deriveProviderModelDiscoveryState({
      data: realResult,
      dataUpdatedAt: 1234,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });
    expect(state).toMatchObject({
      status: "success",
      hasDynamicList: true,
      refreshing: false,
      fetchedAt: 1234,
    });
  });

  it("propagates a background refetch as refreshing for settled states", () => {
    const successState = deriveProviderModelDiscoveryState({
      data: realResult,
      dataUpdatedAt: 1234,
      isFetching: true,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });
    expect(successState).toMatchObject({ status: "success", refreshing: true, fetchedAt: 1234 });

    const failedWithCacheState = deriveProviderModelDiscoveryState({
      data: realResult,
      dataUpdatedAt: 1234,
      isFetching: true,
      isLoading: false,
      isPlaceholderData: false,
      status: "error",
    });
    expect(failedWithCacheState).toMatchObject({
      status: "failed",
      hasDynamicList: true,
      refreshing: true,
    });
  });

  it("reports placeholder data carried over from a previous query key as refreshing success", () => {
    const state = deriveProviderModelDiscoveryState({
      data: realResult,
      dataUpdatedAt: 0,
      isFetching: true,
      isLoading: false,
      isPlaceholderData: true,
      status: "success",
    });
    expect(state).toMatchObject({
      status: "success",
      hasDynamicList: true,
      refreshing: true,
      fetchedAt: undefined,
    });
  });

  it("leaves fetchedAt undefined when the query carries no dataUpdatedAt", () => {
    const state = deriveProviderModelDiscoveryState({
      data: realResult,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });
    expect(state).toMatchObject({ status: "success", hasDynamicList: true, fetchedAt: undefined });
  });

  it("returns empty for a real source with zero models", () => {
    const state = deriveProviderModelDiscoveryState({
      data: {
        models: [] as ProviderModelDescriptor[],
        source: "opencode" as const,
        cached: false as const,
      },
      dataUpdatedAt: 1234,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      status: "success",
    });
    expect(state).toMatchObject({
      status: "empty",
      hasDynamicList: false,
      refreshing: false,
      fetchedAt: 1234,
    });
  });

  it("returns failed when there is no usable list", () => {
    expect(
      deriveProviderModelDiscoveryState({
        data: undefined,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
        status: "error",
      }),
    ).toEqual({ status: "failed", hasDynamicList: false, refreshing: false });
  });

  it("returns failed-with-cache when a stale list exists", () => {
    const state = deriveProviderModelDiscoveryState({
      data: realResult,
      dataUpdatedAt: 1234,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      status: "error",
    });
    expect(state).toMatchObject({
      status: "failed",
      hasDynamicList: true,
      refreshing: false,
      fetchedAt: 1234,
    });
  });

  it("treats disabled/unsupported sources as never-loaded", () => {
    for (const source of ["disabled", "unsupported"] as const) {
      expect(
        deriveProviderModelDiscoveryState({
          data: { models: [] as ProviderModelDescriptor[], source, cached: false as const },
          isFetching: false,
          isLoading: false,
          isPlaceholderData: false,
          status: "success",
        }),
      ).toEqual({ status: "never-loaded", hasDynamicList: false, refreshing: false });
    }
  });
});

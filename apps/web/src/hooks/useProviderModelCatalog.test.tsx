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
import { useProviderModelCatalog } from "./useProviderModelCatalog";

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
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly isPlaceholderData: boolean;
}

const EMPTY_QUERY: QueryResultLike = {
  isFetching: false,
  isLoading: false,
  isPlaceholderData: false,
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
  customGrokModels: [],
  customKiloModels: [],
  customOpenCodeModels: [],
  customPiModels: [],
  droidBinaryPath: "",
  grokBinaryPath: "",
  hiddenProviders: [],
  kiloBinaryPath: "",
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
      targetExecutable: true,
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    });

    expect(second).toBe(first);
    expect(second?.customModelsByProvider).toBe(first?.customModelsByProvider);
    expect(second?.modelOptionsByProvider).toBe(first?.modelOptionsByProvider);
    expect(second?.loadingModelProviders).toBe(first?.loadingModelProviders);
    expect(second?.runtimeModelsByProvider).toBe(first?.runtimeModelsByProvider);
    expect(second?.selectedRuntimeAgents).toBe(first?.selectedRuntimeAgents);
  });

  it("discovers core agents only when selected unless eager-core is requested", () => {
    readCatalogRenders({
      selectedProvider: "cursor",
      targetExecutable: true,
      discoveryEnabled: false,
    });
    expect(readAgentQueryEnabled("claudeAgent")).toBe(false);
    expect(readAgentQueryEnabled("codex")).toBe(false);

    mocks.useQuery.mockClear();
    readCatalogRenders({
      selectedProvider: "cursor",
      targetExecutable: true,
      discoveryEnabled: false,
      agentDiscoveryPolicy: "eager-core",
    });
    expect(readAgentQueryEnabled("claudeAgent")).toBe(true);
    expect(readAgentQueryEnabled("codex")).toBe(true);
  });

  it("suppresses all provider discovery for an unsupported account target", () => {
    readCatalogRenders({
      selectedProvider: "codex",
      targetExecutable: false,
      discoveryEnabled: true,
      agentDiscoveryPolicy: "eager-core",
    });

    for (const provider of [
      "codex",
      "claudeAgent",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "kilo",
      "opencode",
      "pi",
    ] as const) {
      expect(readModelQueryEnabled(provider)).toBe(false);
    }
    expect(readAgentQueryEnabled("codex")).toBe(false);
    expect(readAgentQueryEnabled("claudeAgent")).toBe(false);
    expect(readAgentQueryEnabled("kilo")).toBe(false);
    expect(readAgentQueryEnabled("opencode")).toBe(false);
  });

  it("does not expose cached default-account discovery for an unsupported target", () => {
    modelQueries.set("codex", {
      data: {
        models: [
          { slug: "cached-selected-model", name: "Cached selected model" },
          { slug: "cached-default-only", name: "Cached default only" },
        ],
        source: "codex.app-server",
        cached: true,
      },
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
    });
    agentQueries.set("codex", {
      data: {
        agents: [{ name: "cached-default-agent", displayName: "Cached default agent" }],
        cached: true,
      },
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "codex",
      targetExecutable: false,
      discoveryEnabled: true,
      modelHintByProvider: { codex: "cached-selected-model" },
      agentDiscoveryPolicy: "eager-core",
    }).at(-1);

    expect(catalog?.modelOptionsByProvider.codex.map((model) => model.slug)).not.toContain(
      "cached-default-only",
    );
    expect(catalog?.runtimeModelsByProvider.codex).toEqual([]);
    expect(catalog?.selectedRuntimeModel).toBeUndefined();
    expect(catalog?.selectedRuntimeAgents).toEqual([]);
    expect(catalog?.selectedProviderModelsLoading).toBe(false);
  });

  it("does not prefetch providers hidden from picker surfaces", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, hiddenProviders: ["cursor"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });

    readCatalogRenders({
      selectedProvider: "codex",
      targetExecutable: true,
      discoveryEnabled: true,
    });

    expect(readModelQueryEnabled("codex")).toBe(true);
    expect(readModelQueryEnabled("cursor")).toBe(false);
    expect(readModelQueryEnabled("antigravity")).toBe(true);
  });

  it("keeps an enabled selected provider discoverable when it is hidden", () => {
    mocks.useAppSettings.mockReturnValue({
      settings: { ...SETTINGS, hiddenProviders: ["cursor"] },
      serverSettings: DEFAULT_SERVER_SETTINGS,
    });

    readCatalogRenders({
      selectedProvider: "cursor",
      targetExecutable: true,
      discoveryEnabled: false,
    });

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

    readCatalogRenders({
      selectedProvider: "cursor",
      targetExecutable: true,
      discoveryEnabled: true,
    });

    expect(readModelQueryEnabled("cursor")).toBe(false);
  });

  it("keeps discovering while the server settings are unavailable", () => {
    // `serverSettings` is undefined until the settings query resolves, and stays
    // undefined for good if it fails — the query never refetches on its own. Failing
    // closed here would blank every provider's model list, selected one included.
    mocks.useAppSettings.mockReturnValue({ settings: SETTINGS, serverSettings: undefined });

    readCatalogRenders({
      selectedProvider: "claudeAgent",
      targetExecutable: true,
      discoveryEnabled: true,
    });

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

    readCatalogRenders({
      selectedProvider: "cursor",
      targetExecutable: true,
      discoveryEnabled: false,
    });

    expect(readModelQueryEnabled("cursor")).toBe(true);
  });

  it("restricts non-picker prefetch to the requested providers", () => {
    readCatalogRenders({
      selectedProvider: "codex",
      targetExecutable: true,
      discoveryEnabled: true,
      prefetchProviders: ["codex", "kilo", "opencode"],
    });

    expect(readModelQueryEnabled("codex")).toBe(true);
    expect(readModelQueryEnabled("kilo")).toBe(true);
    expect(readModelQueryEnabled("opencode")).toBe(true);
    expect(readModelQueryEnabled("cursor")).toBe(false);
    expect(readModelQueryEnabled("antigravity")).toBe(false);
  });

  it("merges a settled runtime catalog with custom models without reporting loading", () => {
    modelQueries.set("cursor", {
      data: {
        models: [{ slug: "composer-2", name: "Composer 2" }],
        source: "cursor.cli",
        cached: false,
      },
      isFetching: true,
      isLoading: false,
      isPlaceholderData: true,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "cursor",
      targetExecutable: true,
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    }).at(-1);

    expect(catalog?.modelOptionsByProvider.cursor.map((model) => model.slug)).toEqual([
      "composer-2",
      "cursor-custom",
    ]);
    expect(catalog?.loadingModelProviders.cursor).toBe(false);
    expect(catalog?.selectedProviderModelsLoading).toBe(false);
    expect(catalog?.runtimeModelsByProvider.cursor).toEqual([
      { slug: "composer-2", name: "Composer 2" },
    ]);
  });
});

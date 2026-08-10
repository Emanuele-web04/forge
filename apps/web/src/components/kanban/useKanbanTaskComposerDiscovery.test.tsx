// FILE: useKanbanTaskComposerDiscovery.test.tsx
// Purpose: Verifies account-target guards mask provider discovery caches in the kanban composer.
// Layer: Kanban UI hook tests

import type { ProviderKind, ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useKanbanTaskComposerDiscovery } from "./useKanbanTaskComposerDiscovery";

const mocks = vi.hoisted(() => ({
  buildSearchableModelOptions: vi.fn(),
  useComposerCommandMenuItems: vi.fn(),
  useDebouncedValue: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: mocks.useQuery };
});

vi.mock("@tanstack/react-pacer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-pacer")>();
  return { ...actual, useDebouncedValue: mocks.useDebouncedValue };
});

vi.mock("~/hooks/useComposerCommandMenuItems", () => ({
  buildSearchableModelOptions: mocks.buildSearchableModelOptions,
  useComposerCommandMenuItems: mocks.useComposerCommandMenuItems,
}));

interface QueryOptionsLike {
  readonly queryKey: readonly unknown[];
}

const PROVIDERS: readonly ProviderKind[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
];
const MODEL_OPTIONS_BY_PROVIDER = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider,
    provider === "codex" ? [{ slug: "static-model", name: "Static model" }] : [],
  ]),
) as Parameters<typeof useKanbanTaskComposerDiscovery>[0]["modelOptionsByProvider"];
const WORKSPACE_ENTRY = { kind: "file", name: "local.ts", path: "src/local.ts" };
const SEARCHABLE_STATIC_MODEL = {
  provider: "codex",
  providerLabel: "Codex",
  slug: "static-model",
  name: "Static model",
  searchSlug: "static-model",
  searchName: "static model",
  searchProvider: "codex",
  searchUpstreamProvider: "",
};

beforeEach(() => {
  mocks.buildSearchableModelOptions.mockReset().mockReturnValue([SEARCHABLE_STATIC_MODEL]);
  mocks.useComposerCommandMenuItems.mockReset().mockReturnValue([]);
  mocks.useDebouncedValue
    .mockReset()
    .mockImplementation((value: string) => [value, { state: { isPending: false } }]);
  mocks.useQuery.mockReset().mockImplementation((options: QueryOptionsLike) => {
    const resource = options.queryKey[1];
    if (resource === "composer-capabilities") {
      return {
        data: {
          provider: "codex",
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: true,
          supportsPluginMentions: true,
          supportsPluginDiscovery: true,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: true,
        },
        isLoading: true,
        isFetching: true,
      };
    }
    if (resource === "commands") {
      return {
        data: {
          commands: [{ name: "cached-command", description: "From the default account" }],
          source: "cache",
          cached: true,
        },
        isLoading: true,
        isFetching: true,
      };
    }
    if (resource === "skills") {
      return {
        data: {
          skills: [
            {
              name: "cached-skill",
              path: "/default-account/cached-skill",
              description: "From the default account",
            },
          ],
          source: "cache",
          cached: true,
        },
        isLoading: true,
        isFetching: true,
      };
    }
    if (resource === "plugins") {
      return {
        data: {
          marketplaces: [
            {
              name: "cached-marketplace",
              path: "/default-account/marketplace",
              plugins: [{ name: "cached-plugin", description: "From the default account" }],
            },
          ],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "cache",
          cached: true,
        },
        isLoading: true,
        isFetching: true,
      };
    }
    if (resource === "search-entries") {
      return {
        data: { entries: [WORKSPACE_ENTRY], truncated: false },
        isLoading: false,
        isFetching: false,
      };
    }
    throw new Error(`Unexpected query resource: ${String(resource)}`);
  });
});

describe("useKanbanTaskComposerDiscovery", () => {
  it("masks cached provider discovery while preserving local workspace and static models", () => {
    let result: ReturnType<typeof useKanbanTaskComposerDiscovery> | undefined;

    function Probe() {
      result = useKanbanTaskComposerDiscovery({
        composerTrigger: { kind: "mention", query: "local", rangeStart: 0, rangeEnd: 6 },
        selectedProvider: "codex",
        targetExecutable: false,
        modelOptionsByProvider: MODEL_OPTIONS_BY_PROVIDER,
        selectedRuntimeAgents: [],
        selectedProjectCwd: "/workspace",
        serverCwd: "/workspace",
        serverHomeDir: "/home/tester",
        scratchThreadId: "scratch-thread" as ThreadId,
        providerOptionsForDispatch: undefined,
        hiddenProviders: [],
        providerOrder: PROVIDERS,
        piAgentDir: null,
      });
      return null;
    }

    renderToStaticMarkup(<Probe />);

    const menuInput = mocks.useComposerCommandMenuItems.mock.calls.at(-1)?.[0] as {
      providerPlugins: readonly unknown[];
      providerNativeCommands: readonly unknown[];
      providerSkills: readonly unknown[];
      workspaceEntries: readonly unknown[];
      searchableModelOptions: readonly unknown[];
    };
    expect(menuInput.providerPlugins).toEqual([]);
    expect(menuInput.providerNativeCommands).toEqual([]);
    expect(menuInput.providerSkills).toEqual([]);
    expect(menuInput.workspaceEntries).toEqual([WORKSPACE_ENTRY]);
    expect(menuInput.searchableModelOptions).toEqual([SEARCHABLE_STATIC_MODEL]);
    expect(result?.isComposerMenuLoading).toBe(false);
  });
});

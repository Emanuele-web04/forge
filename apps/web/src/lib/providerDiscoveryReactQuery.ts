import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListAgentsResult,
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderSkillsCatalogResult,
} from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: "empty",
  cached: false,
};

const EMPTY_COMMANDS_RESULT: ProviderListCommandsResult = {
  commands: [],
  source: "empty",
  cached: false,
};

const EMPTY_MODELS_RESULT: ProviderListModelsResult = {
  models: [],
  source: "empty",
  cached: false,
};

const EMPTY_AGENTS_RESULT: ProviderListAgentsResult = {
  agents: [],
  source: "empty",
  cached: false,
};

const EMPTY_PLUGINS_RESULT: ProviderListPluginsResult = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  remoteSyncError: null,
  featuredPluginIds: [],
  source: "empty",
  cached: false,
};

// The server admits at most two expensive reads at once, and agent discovery
// uses the same budget. Keep model discovery to one request at a time so opening
// the provider picker cannot reject most catalogs before their CLIs even run.
// Foreground requests may move ahead of queued warming, but never interrupt the
// discovery that already owns the single model slot.
type ProviderModelDiscoveryPriority = "background" | "prefetch" | "foreground";

interface ProviderModelDiscoveryTask {
  readonly queryKey: readonly unknown[];
  priority: ProviderModelDiscoveryPriority;
  priorityOrder: number;
  readonly signal: AbortSignal;
  readonly discover: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly abort: () => void;
}

const providerModelDiscoveryQueue: ProviderModelDiscoveryTask[] = [];
// Each selected pane owns a separate lease, released on selection change or unmount.
const foregroundModelDiscoveryOwners = new Set<readonly unknown[]>();
let providerModelDiscoveryRunning = false;
let providerModelDiscoveryPriorityOrder = 0;

const PROVIDER_MODEL_DISCOVERY_PRIORITY_RANK: Record<ProviderModelDiscoveryPriority, number> = {
  background: 0,
  prefetch: 1,
  foreground: 2,
};

function queryKeysMatch(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

function abortReason(signal: AbortSignal): unknown {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new Error("Provider model discovery was cancelled.");
}

function drainProviderModelDiscoveryQueue(): void {
  if (providerModelDiscoveryRunning) return;

  let nextIndex = 0;
  for (let index = 1; index < providerModelDiscoveryQueue.length; index += 1) {
    const candidate = providerModelDiscoveryQueue[index];
    const current = providerModelDiscoveryQueue[nextIndex];
    if (!candidate || !current) continue;
    const candidateRank = PROVIDER_MODEL_DISCOVERY_PRIORITY_RANK[candidate.priority];
    const currentRank = PROVIDER_MODEL_DISCOVERY_PRIORITY_RANK[current.priority];
    if (
      candidateRank > currentRank ||
      (candidateRank === currentRank &&
        candidate.priority !== "background" &&
        candidate.priorityOrder > current.priorityOrder)
    ) {
      nextIndex = index;
    }
  }
  const task = providerModelDiscoveryQueue.splice(nextIndex, 1)[0];
  if (!task) return;

  task.signal.removeEventListener("abort", task.abort);
  if (task.signal.aborted) {
    task.reject(abortReason(task.signal));
    drainProviderModelDiscoveryQueue();
    return;
  }

  providerModelDiscoveryRunning = true;
  void Promise.resolve()
    .then(task.discover)
    .then(task.resolve, task.reject)
    .finally(() => {
      providerModelDiscoveryRunning = false;
      drainProviderModelDiscoveryQueue();
    });
}

export function prioritizeProviderModelDiscovery(
  queryKey: readonly unknown[],
  priority: Exclude<ProviderModelDiscoveryPriority, "background"> = "foreground",
): (() => void) | undefined {
  const owner = priority === "foreground" ? [...queryKey] : undefined;
  if (owner) foregroundModelDiscoveryOwners.add(owner);
  for (const task of providerModelDiscoveryQueue) {
    const matches = queryKeysMatch(task.queryKey, queryKey);
    if (!matches && priority === "prefetch" && task.priority === "prefetch") {
      // Only the newest hover target remains prefetch-priority. Foreground
      // catalogs are not exclusive: split-view panes can observe distinct
      // selected providers at the same time.
      task.priority = "background";
    } else if (matches) {
      if (
        task.priority === "background" ||
        (task.priority === "prefetch" && priority === "foreground")
      ) {
        task.priority = priority;
      }
      // A newly selected pane goes first without demoting catalogs selected
      // in other active panes below speculative prefetch work.
      task.priorityOrder = ++providerModelDiscoveryPriorityOrder;
    }
  }
  if (!owner) return;
  return () => {
    foregroundModelDiscoveryOwners.delete(owner);
    if ([...foregroundModelDiscoveryOwners].some((key) => queryKeysMatch(key, queryKey))) return;
    for (const task of providerModelDiscoveryQueue) {
      if (queryKeysMatch(task.queryKey, queryKey) && task.priority === "foreground") {
        task.priority = "background";
        task.priorityOrder = 0;
      }
    }
  };
}

function serializeProviderModelDiscovery<T>(
  queryKey: readonly unknown[],
  signal: AbortSignal,
  priority: ProviderModelDiscoveryPriority,
  discover: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const taskIndex = providerModelDiscoveryQueue.findIndex((task) => task.abort === abort);
      if (taskIndex < 0) return;
      providerModelDiscoveryQueue.splice(taskIndex, 1);
      reject(abortReason(signal));
    };
    const effectivePriority = [...foregroundModelDiscoveryOwners].some((key) =>
      queryKeysMatch(key, queryKey),
    )
      ? "foreground"
      : priority;
    providerModelDiscoveryQueue.push({
      queryKey,
      priority: effectivePriority,
      priorityOrder: effectivePriority === "background" ? 0 : ++providerModelDiscoveryPriorityOrder,
      signal,
      discover,
      resolve: (value) => resolve(value as T),
      reject,
      abort,
    });
    signal.addEventListener("abort", abort, { once: true });
    drainProviderModelDiscoveryQueue();
  });
}

function requireDiscoveredModels(
  provider: ProviderKind,
  result: ProviderListModelsResult,
  previous: ProviderListModelsResult | undefined,
): ProviderListModelsResult {
  // Initial degraded discovery can still expose an adapter's usable static
  // fallback. During a background refresh, however, keep a previously good
  // dynamic catalog and let React Query retry the transient failure.
  if (
    provider === "devin" &&
    result.error &&
    previous &&
    !previous.error &&
    previous.models.length > 0
  ) {
    throw new Error(result.error);
  }
  const isAuthoritativeEmptyCatalog =
    result.source === "disabled" ||
    result.source === "unsupported" ||
    (provider === "opencode" &&
      (result.source === "opencode" || result.source === "opencode-cli")) ||
    (provider === "pi" && result.source?.startsWith("pi.sdk") === true);
  if (
    provider !== "codex" &&
    provider !== "claudeAgent" &&
    result.models.length === 0 &&
    !isAuthoritativeEmptyCatalog
  ) {
    throw new Error(`${provider} model discovery returned no models.`);
  }
  return result;
}

export const providerDiscoveryQueryKeys = {
  all: ["provider-discovery"] as const,
  modelsAll: ["provider-discovery", "models"] as const,
  composerCapabilities: (provider: ProviderKind) =>
    ["provider-discovery", "composer-capabilities", provider] as const,
  commands: (
    provider: ProviderKind,
    cwd: string | null,
    agentDir: string | null,
    connectionKey: string | null,
  ) => ["provider-discovery", "commands", provider, cwd, agentDir, connectionKey] as const,
  // The skill list is query-independent (filtering is client-side), so the key
  // deliberately excludes the typed filter to avoid a refetch per keystroke.
  skills: (provider: ProviderKind, cwd: string | null, agentDir: string | null) =>
    ["provider-discovery", "skills", provider, cwd, agentDir] as const,
  skillsCatalog: (cwd: string | null) => ["provider-discovery", "skills-catalog", cwd] as const,
  plugins: (provider: ProviderKind, cwd: string | null, threadId: string | null) =>
    ["provider-discovery", "plugins", provider, cwd, threadId] as const,
  plugin: (
    provider: ProviderKind,
    marketplacePath: string,
    pluginName: string,
    cwd: string | null,
    threadId: string | null,
  ) =>
    ["provider-discovery", "plugin", provider, marketplacePath, pluginName, cwd, threadId] as const,
  models: (
    provider: ProviderKind,
    binaryPath: string | null,
    apiEndpoint: string | null,
    agentDir: string | null,
    cwd: string | null,
  ) => ["provider-discovery", "models", provider, binaryPath, apiEndpoint, agentDir, cwd] as const,
  agentsForProvider: (provider: ProviderKind) =>
    ["provider-discovery", "agents", provider] as const,
  agents: (provider: ProviderKind, binaryPath: string | null, cwd: string | null) =>
    [...providerDiscoveryQueryKeys.agentsForProvider(provider), binaryPath, cwd] as const,
};

export function providerModelDiscoveryRetry(provider: ProviderKind): number {
  return provider === "cursor" ? 0 : provider === "droid" ? 2 : 3;
}

export function providerComposerCapabilitiesQueryOptions(provider: ProviderKind) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.composerCapabilities(provider),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.getComposerCapabilities({ provider });
    },
    staleTime: Infinity,
  });
}

export function providerSkillsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skills(input.provider, input.cwd, input.agentDir ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Skill discovery is unavailable.");
      }
      return api.provider.listSkills({
        provider: input.provider,
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT,
  });
}

// Unified cross-provider skills catalog (settings page); not filtered by toggles.
// Keep prior data during refetches so Settings does not flicker back to "Scanning..."
// while the server refreshes filesystem discovery in the background.
export function skillsCatalogQueryOptions(input?: { cwd?: string | null; enabled?: boolean }) {
  const cwd = input?.cwd ?? null;
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skillsCatalog(cwd),
    queryFn: async (): Promise<ProviderSkillsCatalogResult> => {
      const api = ensureNativeApi();
      return api.provider.listSkillsCatalog(cwd ? { cwd } : {});
    },
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

export function providerCommandsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  binaryPath?: string | null;
  serverUrl?: string | null;
  // Undefined means "not applicable" (non-OpenCode providers); the body normalizes it.
  experimentalWebSockets?: boolean | undefined;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  const connectionKey = JSON.stringify({
    binaryPath: input.binaryPath ?? null,
    serverUrl: input.serverUrl ?? null,
    experimentalWebSockets: input.experimentalWebSockets ?? null,
  });
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.commands(
      input.provider,
      input.cwd,
      input.agentDir ?? null,
      connectionKey,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Command discovery is unavailable.");
      }
      return api.provider.listCommands({
        provider: input.provider,
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(input.experimentalWebSockets !== undefined
          ? { experimentalWebSockets: input.experimentalWebSockets }
          : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_COMMANDS_RESULT,
  });
}

/**
 * True only while the first real models fetch is still outstanding.
 * Once discovery settles — with a catalog OR a failure (e.g. missing Cursor
 * CLI, #103) — background refetches must not re-blank the composer picker,
 * and a failed provider must not park the model control on a skeleton.
 */
export function isInitialModelDiscoveryPending(query: {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
}): boolean {
  return query.isLoading || (query.isFetching && query.isPlaceholderData);
}

export function providerModelsQueryOptions(input: {
  provider: ProviderKind;
  binaryPath?: string | null;
  apiEndpoint?: string | null;
  agentDir?: string | null;
  cwd?: string | null;
  enabled?: boolean;
  priority?: ProviderModelDiscoveryPriority | undefined;
}) {
  const queryKey = providerDiscoveryQueryKeys.models(
    input.provider,
    input.binaryPath ?? null,
    input.apiEndpoint ?? null,
    input.agentDir ?? null,
    input.cwd ?? null,
  );
  return queryOptions<ProviderListModelsResult, Error, ProviderListModelsResult, typeof queryKey>({
    queryKey,
    queryFn: ({ client, signal }): Promise<ProviderListModelsResult> =>
      serializeProviderModelDiscovery(
        queryKey,
        signal,
        input.priority ?? "background",
        async () => {
          const api = ensureNativeApi();
          const result = await api.provider.listModels({
            provider: input.provider,
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            ...(input.apiEndpoint ? { apiEndpoint: input.apiEndpoint } : {}),
            ...(input.agentDir ? { agentDir: input.agentDir } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
          });
          const previous = client.getQueryData<ProviderListModelsResult>(queryKey);
          return requireDiscoveredModels(input.provider, result, previous);
        },
      ),
    enabled: input.enabled ?? true,
    // Cached catalogs paint immediately while stale entries revalidate in the
    // background. Droid discovery starts a disposable ACP session, so retain its
    // longer cache and never repeat that work merely because the window regained focus.
    retry: providerModelDiscoveryRetry(input.provider),
    staleTime:
      input.provider === "devin"
        ? (query) => (query.state.data?.error ? 0 : 30_000)
        : input.provider === "droid"
          ? 5 * 60_000
          : 30_000,
    // Devin deliberately returns a usable static catalog when CLI discovery
    // fails. Keep it visible, but retry while observed instead of treating the
    // degraded result as a successful 30-minute cache entry. A failed refresh
    // retains healthy data, so the query error must also keep recovery polling alive.
    ...(input.provider === "devin"
      ? {
          refetchInterval: (query) =>
            query.state.data?.error || query.state.error ? 30_000 : false,
        }
      : {}),
    ...(input.provider === "droid" ? { refetchOnWindowFocus: false } : {}),
    // 30min — matches NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS in
    // providerModelPrefetch.ts (not imported: that module imports from here).
    gcTime: 30 * 60_000,
    placeholderData: (previous) => previous ?? EMPTY_MODELS_RESULT,
  });
}

export function providerAgentsQueryOptions(input: {
  provider: ProviderKind;
  binaryPath?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.agents(
      input.provider,
      input.binaryPath ?? null,
      input.cwd ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listAgents({
        provider: input.provider,
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_AGENTS_RESULT,
  });
}

export function providerPluginsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.plugins(input.provider, input.cwd, input.threadId ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listPlugins({
        provider: input.provider,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_PLUGINS_RESULT,
  });
}

export function supportsSkillDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsSkillDiscovery === true;
}

export function supportsNativeSlashCommandDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsNativeSlashCommandDiscovery === true;
}

export function supportsPluginDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsPluginDiscovery === true;
}

export function supportsThreadCompaction(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadCompaction === true;
}

export function supportsThreadImport(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadImport === true;
}

import {
  type ModelSelection,
  type ProviderKind,
  type ProviderStartOptions,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { resolveGitTextGenerationSelection } from "./model";
import { deepMerge, type DeepPartial } from "./Struct";

/**
 * Whether a selection patch replaces the whole selection (provider or a
 * non-empty model is present). A whitespace-only model is treated as absent in
 * the options merge: it still resolves to the provider's registered default,
 * but it must not drop persisted option overrides (an empty patch preserves
 * them).
 */
function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(
    patch &&
    (patch.provider !== undefined || (patch.model !== undefined && patch.model.trim() !== "")),
  );
}

/** Build the final selection shape from a base selection and optional options. */
function withSelectionOptions(
  selection: { readonly provider: ProviderKind; readonly model: string },
  options:
    | ModelSelection["options"]
    | NonNullable<ServerSettingsPatch["textGenerationModelSelection"]>["options"]
    | undefined,
): ModelSelection {
  return (options !== undefined ? { ...selection, options } : selection) as ModelSelection;
}

/**
 * Merge a settings patch into the persisted settings.
 *
 * The textGenerationModelSelection part is resolved atomically through the one
 * shared resolver (see resolveGitTextGenerationSelection). When the resolver
 * REJECTS a partial patch — it cannot attribute a model-only patch without
 * creating a mismatched pair — the current selection is kept verbatim: never a
 * mismatched pair, never a silent model discard. Option overrides still follow
 * the patch as before. Note: any patch that touches provider/model replaces
 * the persisted option overrides with the patch's options (none for a
 * provider-only/model-only patch).
 *
 * The optional `resolveAgainst` view separates the deep-merge base from the
 * resolution context. `current` is always the RAW persisted row, so an
 * unrelated/options-only/empty selection patch never disturbs the persisted
 * pair (a temporary disabled-provider fallback alone never changes
 * persistence). A deliberate provider/model edit resolves against
 * `resolveAgainst` instead — the EFFECTIVE view the UI actually displays —
 * so a model-only patch while viewing a fallback is attributed to the
 * provider the user is looking at, not to the hidden persisted provider.
 * When omitted, `current` is also the resolution context.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
  resolveAgainst?: ServerSettings,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = deepMerge(current, patch as DeepPartial<ServerSettings>);
  if (!selectionPatch) {
    return next;
  }

  // Options-only or empty selection patch: preserve the persisted pair exactly
  // (no silent migration) and only replace the option overrides.
  if (selectionPatch.provider === undefined && selectionPatch.model === undefined) {
    return {
      ...next,
      textGenerationModelSelection: withSelectionOptions(
        current.textGenerationModelSelection,
        selectionPatch.options ?? current.textGenerationModelSelection.options,
      ),
    };
  }

  // Resolve the whole selection atomically through the one shared resolver, so
  // the web patch path and this direct merge boundary cannot drift. A provider
  // outside the Git text generation registry (claudeAgent, antigravity, grok, droid,
  // pi) with no explicit model resolves to the complete Codex/Luna pair and
  // never borrows another provider's model.
  const resolvedSelection = resolveGitTextGenerationSelection({
    provider: selectionPatch.provider,
    model: selectionPatch.model,
    currentProvider: (resolveAgainst ?? current).textGenerationModelSelection.provider,
  });

  // The resolver REJECTED the patch (e.g. a foreign bare slug under Codex):
  // keep the current selection verbatim, with options from the patch as today.
  if (resolvedSelection === null) {
    return {
      ...next,
      textGenerationModelSelection: withSelectionOptions(
        current.textGenerationModelSelection,
        shouldReplaceTextGenerationModelSelection(selectionPatch)
          ? selectionPatch.options
          : (selectionPatch.options ?? current.textGenerationModelSelection.options),
      ),
    };
  }

  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? current.textGenerationModelSelection.options);

  return {
    ...next,
    textGenerationModelSelection: withSelectionOptions(resolvedSelection, options),
  };
}

/** Server-owned launch options derived from the persisted non-secret settings snapshot. */
export function providerStartOptionsFromServerSettings(
  settings: ServerSettings,
): ProviderStartOptions {
  const { providers } = settings;
  return {
    codex: {
      ...(providers.codex.binaryPath ? { binaryPath: providers.codex.binaryPath } : {}),
      ...(providers.codex.homePath ? { homePath: providers.codex.homePath } : {}),
    },
    claudeAgent: {
      ...(providers.claudeAgent.binaryPath ? { binaryPath: providers.claudeAgent.binaryPath } : {}),
    },
    cursor: {
      ...(providers.cursor.binaryPath ? { binaryPath: providers.cursor.binaryPath } : {}),
      ...(providers.cursor.apiEndpoint ? { apiEndpoint: providers.cursor.apiEndpoint } : {}),
    },
    antigravity: {
      ...(providers.antigravity.binaryPath ? { binaryPath: providers.antigravity.binaryPath } : {}),
    },
    grok: {
      ...(providers.grok.binaryPath ? { binaryPath: providers.grok.binaryPath } : {}),
    },
    droid: {
      ...(providers.droid.binaryPath ? { binaryPath: providers.droid.binaryPath } : {}),
    },
    kilo: {
      ...(providers.kilo.binaryPath ? { binaryPath: providers.kilo.binaryPath } : {}),
      ...(providers.kilo.serverUrl ? { serverUrl: providers.kilo.serverUrl } : {}),
    },
    opencode: {
      ...(providers.opencode.binaryPath ? { binaryPath: providers.opencode.binaryPath } : {}),
      ...(providers.opencode.serverUrl ? { serverUrl: providers.opencode.serverUrl } : {}),
      experimentalWebSockets: providers.opencode.experimentalWebSockets,
    },
    pi: {
      ...(providers.pi.binaryPath ? { binaryPath: providers.pi.binaryPath } : {}),
      ...(providers.pi.agentDir ? { agentDir: providers.pi.agentDir } : {}),
    },
  };
}

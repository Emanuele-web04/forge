import {
  type ModelSelection,
  type ProviderStartOptions,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { defaultGitTextGenerationSelectionFor, resolveGitTextGenerationSelection } from "./model";
import { deepMerge, type DeepPartial } from "./Struct";

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.provider !== undefined || patch.model !== undefined));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = deepMerge(current, patch as DeepPartial<ServerSettings>);
  if (!selectionPatch) {
    return next;
  }

  // Options-only or empty selection patch: preserve the persisted pair exactly
  // (no silent migration) and only replace the option overrides.
  if (selectionPatch.provider === undefined && selectionPatch.model === undefined) {
    const options = selectionPatch.options ?? current.textGenerationModelSelection.options;
    return {
      ...next,
      textGenerationModelSelection: {
        ...current.textGenerationModelSelection,
        ...(options !== undefined ? { options } : {}),
      } as ModelSelection,
    };
  }

  // Resolve the whole selection atomically through the one shared resolver, so
  // the web patch path and this direct merge boundary cannot drift. A provider
  // outside the Git writing registry (claudeAgent, antigravity, grok, droid,
  // pi) with no explicit model resolves to the complete Codex/Luna pair and
  // never borrows another provider's model.
  const resolvedSelection = resolveGitTextGenerationSelection({
    provider: selectionPatch.provider,
    model: selectionPatch.model,
    currentProvider: current.textGenerationModelSelection.provider,
  });

  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? current.textGenerationModelSelection.options);

  return {
    ...next,
    textGenerationModelSelection: {
      ...resolvedSelection,
      ...(options !== undefined ? { options } : {}),
    } as ModelSelection,
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

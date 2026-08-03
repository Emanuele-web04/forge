import {
  type ModelSelection,
  type ProviderStartOptions,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { defaultGitTextGenerationSelectionFor } from "./model";
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

  const provider = selectionPatch.provider ?? current.textGenerationModelSelection.provider;
  const explicitModel = selectionPatch.model ?? undefined;
  const providerChanged =
    selectionPatch.provider !== undefined &&
    selectionPatch.provider !== "pi" &&
    selectionPatch.provider !== current.textGenerationModelSelection.provider;

  // Resolve the whole selection atomically. A provider outside the Git writing
  // map (claudeAgent, antigravity, grok, droid, legacy cursor) must never borrow
  // Codex's model: when only the provider changes, either use its mapped default
  // or fall back to the complete Codex/Luna pair.
  const resolvedSelection = (() => {
    // Options-only patch: preserve the current selection untouched.
    if (selectionPatch.provider === undefined && selectionPatch.model === undefined) {
      return current.textGenerationModelSelection;
    }
    if (explicitModel !== undefined && explicitModel.length > 0) {
      return { provider, model: explicitModel } as ModelSelection;
    }
    if (providerChanged || explicitModel === undefined) {
      if (provider === "codex" || provider === "kilo" || provider === "opencode") {
        return defaultGitTextGenerationSelectionFor(provider) as ModelSelection;
      }
      // Unsupported provider with no explicit model: never {claudeAgent, gpt-5.6-luna}.
      return defaultGitTextGenerationSelectionFor("codex") as ModelSelection;
    }
    return { provider, model: current.textGenerationModelSelection.model } as ModelSelection;
  })();

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

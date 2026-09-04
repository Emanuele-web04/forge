import type { ProviderKind, RuntimeMode } from "@synara/contracts";

const AUTO_RUNTIME_MODE_PROVIDERS = new Set<ProviderKind>(["codex", "claudeAgent"]);
const AUTO_RUNTIME_MODE_PROVIDER_KINDS = AUTO_RUNTIME_MODE_PROVIDERS as ReadonlySet<
  ProviderKind | "external"
>;
const RUNTIME_MODE_PRIVILEGE = {
  "approval-required": 0,
  auto: 1,
  "full-access": 2,
} as const satisfies Record<RuntimeMode, number>;

export function providerSupportsAutoRuntimeMode(provider: ProviderKind | "external"): boolean {
  return AUTO_RUNTIME_MODE_PROVIDER_KINDS.has(provider);
}

export function unsupportedAutoRuntimeModeMessage(provider: ProviderKind | "external"): string {
  return `Provider "${provider}" does not support Auto runtime mode. Auto is available only for Codex and Claude Code.`;
}

/**
 * Human-readable reason an Auto-mode model selection is invalid, or null when
 * the selection may run in Auto. Shared by orchestration and automations so
 * both enforce the identical policy.
 */
export function autoRuntimeModeSelectionIssue(input: {
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: {
    readonly provider: ProviderKind | "external";
    readonly model: string;
    readonly supportsAutoMode?: boolean | undefined;
  };
}): string | null {
  if (input.runtimeMode !== "auto") {
    return null;
  }
  if (!providerSupportsAutoRuntimeMode(input.modelSelection.provider)) {
    return unsupportedAutoRuntimeModeMessage(input.modelSelection.provider);
  }
  if (
    input.modelSelection.provider === "claudeAgent" &&
    input.modelSelection.supportsAutoMode !== true
  ) {
    // Fail closed on an unknown capability: the Claude adapter refuses to
    // start Auto sessions without a confirmed flag, so persisting Auto here
    // would only defer the failure to runtime.
    return input.modelSelection.supportsAutoMode === false
      ? `Claude model "${input.modelSelection.model}" does not support Auto mode.`
      : `Claude model "${input.modelSelection.model}" has not been verified to support Auto mode.`;
  }
  return null;
}

export function runtimeModeEscalatesPrivilege(
  callerRuntimeMode: RuntimeMode,
  targetRuntimeMode: RuntimeMode,
): boolean {
  return RUNTIME_MODE_PRIVILEGE[targetRuntimeMode] > RUNTIME_MODE_PRIVILEGE[callerRuntimeMode];
}

export function normalizeRuntimeModeForProvider(
  runtimeMode: RuntimeMode,
  provider: ProviderKind | "external",
): RuntimeMode {
  return runtimeMode === "auto" && !providerSupportsAutoRuntimeMode(provider)
    ? "approval-required"
    : runtimeMode;
}

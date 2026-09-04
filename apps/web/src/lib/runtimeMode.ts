import type {
  ProviderKind,
  ProviderModelDescriptor,
  RuntimeMode,
  ServerProviderStatus,
} from "@synara/contracts";
import {
  normalizeRuntimeModeForProvider,
  providerSupportsAutoRuntimeMode,
} from "@synara/shared/runtimeMode";

export { normalizeRuntimeModeForProvider, providerSupportsAutoRuntimeMode };

export function providerModelSupportsAutoRuntimeMode(
  provider: ProviderKind | "external",
  runtimeModel?: ProviderModelDescriptor,
  providerStatus?: ServerProviderStatus | null,
): boolean {
  if (!providerSupportsAutoRuntimeMode(provider)) {
    return false;
  }
  return (
    providerStatus?.supportsAutoRuntimeMode === true &&
    (provider !== "claudeAgent" || runtimeModel?.supportsAutoMode === true)
  );
}

export const RUNTIME_MODE_PRESENTATION: Record<
  RuntimeMode,
  { readonly label: string; readonly description: string }
> = {
  "approval-required": {
    label: "Ask for approval",
    description: "Always ask to edit external files and use the internet",
  },
  auto: {
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe",
  },
  "full-access": {
    label: "Full access",
    description: "Unrestricted access to the internet and any file on your computer",
  },
};

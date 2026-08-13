import type { ProviderKind, ThreadId } from "@synara/contracts";

export const ONBOARDING_TERMINAL_SCOPE_PREFIX = "onboarding-terminal:";

export function onboardingTerminalThreadId(provider: ProviderKind): ThreadId {
  return `${ONBOARDING_TERMINAL_SCOPE_PREFIX}${provider}` as ThreadId;
}

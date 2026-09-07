// FILE: onboardingTerminalScope.ts
// Purpose: Synthetic terminal scope ids for the provider sign-in terminals shown during
//          the welcome tour, so they never collide with a real thread's terminal state.
// Layer: Web domain helper

import type { ProviderKind, ThreadId } from "@synara/contracts";

export const ONBOARDING_TERMINAL_SCOPE_PREFIX = "onboarding-terminal:";

export function onboardingTerminalThreadId(provider: ProviderKind): ThreadId {
  return `${ONBOARDING_TERMINAL_SCOPE_PREFIX}${provider}` as ThreadId;
}

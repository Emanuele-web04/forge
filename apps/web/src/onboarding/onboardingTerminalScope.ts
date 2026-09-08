// FILE: onboardingTerminalScope.ts
// Purpose: Synthetic terminal scope ids for the provider sign-in terminals shown during
//          the welcome tour, so they never collide with a real thread's terminal state nor
//          with another window's sign-in terminal on the same server.
// Layer: Web domain helper

import type { ProviderKind, ThreadId } from "@synara/contracts";

export const ONBOARDING_TERMINAL_SCOPE_PREFIX = "onboarding-terminal:";

/**
 * Terminal sessions are keyed server-side by thread and terminal id. Two tabs or windows
 * signing in to the same provider would otherwise share one PTY, so each client gets a
 * nonce for the lifetime of the page.
 */
const CLIENT_NONCE = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

export function onboardingTerminalThreadId(provider: ProviderKind): ThreadId {
  return `${ONBOARDING_TERMINAL_SCOPE_PREFIX}${CLIENT_NONCE}:${provider}` as ThreadId;
}

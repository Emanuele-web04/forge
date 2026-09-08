// FILE: enrollment.ts
// Purpose: The consent decision for a newly registered host, and the device-code
//          normalization the approval field applies as you type.
// Layer: Web remote-access feature logic.
// Exports: shouldPromptForDiscoverability, normalizeDeviceUserCode, and friends.

import { DEVICE_USER_CODE_ALPHABET } from "@synara/contracts";

import type { HostEnrollment } from "./api";

/**
 * Why the discoverability prompt is or is not showing. The reason travels with
 * the decision because "no prompt" has three very different meanings — nothing
 * to ask about, nobody to ask on behalf of, and already asked — and a UI that
 * collapsed them would silently swallow the case where the member count is
 * unavailable.
 */
export type DiscoverabilityPromptDecision =
  | { readonly prompt: true }
  | {
      readonly prompt: false;
      readonly reason: "no-host" | "personal-org" | "already-acknowledged" | "unknown-membership";
    };

/**
 * Whether to ask "share this machine with <org>?" before the host becomes
 * discoverable (ADR 0002/0015).
 *
 * Personal orgs never prompt: discoverability defaults on and there is nobody
 * else in the workspace to share with, so a modal there is pure friction. A
 * multi-member org always prompts once, because Desktop registers the bundled
 * host automatically at sign-in and the machine hands out code execution —
 * that must not become an org-wide capability without an explicit yes.
 *
 * An unknown member count does NOT prompt. That looks like the unsafe branch
 * and is the opposite: the prompt is the affirmative step toward sharing, and
 * asking a solo user to consent to sharing with a workspace of one because the
 * identity provider was briefly unreachable teaches them to click through it.
 * The host's own discoverability is unchanged either way, and the next
 * successful enrollment read asks properly.
 */
export function shouldPromptForDiscoverability(
  enrollment: HostEnrollment | null | undefined,
): DiscoverabilityPromptDecision {
  if (!enrollment?.host) return { prompt: false, reason: "no-host" };
  if (enrollment.discoverabilityAcknowledged) {
    return { prompt: false, reason: "already-acknowledged" };
  }
  const members = enrollment.organizationMemberCount;
  if (members === null || !Number.isFinite(members)) {
    return { prompt: false, reason: "unknown-membership" };
  }
  if (members <= 1) return { prompt: false, reason: "personal-org" };
  return { prompt: true };
}

/** Codes are always 8 characters (`LinkDeviceApproveRequest`). */
export const DEVICE_USER_CODE_LENGTH = 8;

/** The display form: `ABCD-EFGH`, so an 8-character code is readable aloud. */
export const DEVICE_USER_CODE_GROUP_SIZE = 4;

const ALPHABET = new Set(DEVICE_USER_CODE_ALPHABET);

/** Shared input rule for every human-compared code using Synara's alphabet. */
export function normalizeUnambiguousCode(raw: string, maxLength: number): string {
  let normalized = "";
  for (const character of raw.toUpperCase()) {
    if (!ALPHABET.has(character)) continue;
    normalized += character;
    if (normalized.length === maxLength) break;
  }
  return normalized;
}

/**
 * What the approval field keeps from a keystroke or a paste.
 *
 * Uppercases first, then drops anything outside the code alphabet — which is
 * what makes the field case-insensitive AND makes `I`, `O`, `0` and `1`
 * disappear rather than sit there failing validation. The alphabet excludes
 * them precisely because they are the characters a person mistypes when
 * copying a code off another screen; silently accepting one would burn an
 * approval attempt against the API's rate limit on a typo the user cannot see.
 *
 * Separators are dropped too, so pasting the displayed `ABCD-EFGH` works.
 */
export function normalizeDeviceUserCode(raw: string): string {
  return normalizeUnambiguousCode(raw, DEVICE_USER_CODE_LENGTH);
}

/** Groups a normalized code for character-by-character comparison. */
export function formatUnambiguousCode(normalized: string, groupSize: number): string {
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += groupSize) {
    groups.push(normalized.slice(index, index + groupSize));
  }
  return groups.join("-");
}

/** `ABCDEFGH` → `ABCD-EFGH`; partial input groups as far as it goes. */
export function formatDeviceUserCode(normalized: string): string {
  return formatUnambiguousCode(normalized, DEVICE_USER_CODE_GROUP_SIZE);
}

/** Whether a normalized code is complete enough to submit. */
export function isCompleteDeviceUserCode(normalized: string): boolean {
  return normalized.length === DEVICE_USER_CODE_LENGTH;
}

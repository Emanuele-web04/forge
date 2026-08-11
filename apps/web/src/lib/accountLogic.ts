// FILE: accountLogic.ts
// Purpose: Pure helpers for the account sign-in/onboarding UI — error-code
// classification of RPC failures and handle/display derivations.
// Layer: Web account feature logic (no I/O).

import {
  AccountErrorCode as AccountErrorCodeSchema,
  AccountProfileHandle,
  type AccountErrorCode,
  type AccountMe,
} from "@synara/contracts";
import { Schema } from "effect";

/** How many digits the WorkOS verification code always has. */
export const VERIFICATION_CODE_LENGTH = 6;

/** How long the resend link stays disabled after entering the step or resending. */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * What the verification step redeems, read off an
 * `email_verification_required` refusal. Lives only in the dialog's state
 * machine — the pending token is a bearer-ish secret and must never be
 * persisted or logged.
 */
export interface EmailVerificationChallenge {
  readonly pendingAuthenticationToken: string;
  readonly email: string;
  readonly emailVerificationId: string;
}

/**
 * Reads the `AccountErrorCode` a failed account RPC carried, if any. The
 * server maps `AccountApiError` onto `WsRpcError.code`; anything else (socket
 * loss, timeout) has no code and is treated as a generic failure.
 */
export function readAccountErrorCode(error: unknown): AccountErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? (code as AccountErrorCode) : null;
}

/**
 * The verification challenge a failed sign-in or sign-up carried, or null.
 * The server maps the refusal onto its own tagged RPC error so the fields
 * survive the WebSocket hop; everything else — including a plain
 * `email_verification_required` code with no payload — is not a challenge
 * this client can complete in-app.
 */
export function readEmailVerificationChallenge(error: unknown): EmailVerificationChallenge | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Record<string, unknown>;
  if (candidate._tag !== "AccountEmailVerificationRequiredError") return null;
  const { pendingAuthenticationToken, email, emailVerificationId } = candidate;
  if (
    typeof pendingAuthenticationToken !== "string" ||
    typeof email !== "string" ||
    typeof emailVerificationId !== "string"
  ) {
    return null;
  }
  return { pendingAuthenticationToken, email, emailVerificationId };
}

/**
 * Digits only, bounded at the code length — what typing or pasting into the
 * code field may leave behind. Pasting "123 456" or "code: 123456" both land
 * the six digits.
 */
export function sanitizeVerificationCodeInput(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, VERIFICATION_CODE_LENGTH);
}

/** "0:47" — the countdown suffix on the resend link. */
export function formatResendCountdown(secondsLeft: number): string {
  const clamped = Math.max(0, Math.ceil(secondsLeft));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Whether a failed sign-in RPC was a CANCELLATION rather than an outcome —
 * our own abort, or the server-side fiber being interrupted (WS lease
 * replaced, reconnect, request superseded). A cancellation carries no verdict
 * on the sign-in: the caller must not render it as an error, and the
 * authoritative account status decides what actually happened.
 *
 * Checked structurally rather than by `instanceof`: the rejection crosses
 * serialization and runtime boundaries, so only tags and shapes survive.
 */
export function isSignInCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // Our own AbortController's rejection, when the raw reason surfaces
  // instead of the transport's wrapper.
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const candidate = error as { _tag?: unknown; code?: unknown; message?: unknown };
  // The transport's own wrapper for an aborted/timed-out request.
  if (candidate._tag === "WsTransportRequestInterruptedError") return true;
  // Effect interruption tags, as they appear on the squashed rejection.
  if (candidate._tag === "Interrupted" || candidate._tag === "InterruptedException") return true;
  // The squashed form a fiber interruption reaches a Promise rejection as.
  // Matching the message is deliberate defense-in-depth: this exact runtime
  // wording was observed rendered in the dialog, and no legitimate account
  // error will ever spell it.
  if (typeof candidate.message === "string" && /fibers?\s+interrupted/i.test(candidate.message)) {
    return true;
  }
  return false;
}

/**
 * Tags of the errors whose `message` this app authored (server-side mappings
 * write them; see accountRpcErrors.ts). Only these may reach the UI verbatim.
 */
const TRUSTED_ACCOUNT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "WsRpcError",
  "AccountEmailVerificationRequiredError",
]);

/**
 * The user-facing message for a failed account call: the error's own message
 * when it is one WE wrote — a `WsRpcError` / verification refusal off the RPC
 * contract, or anything carrying a classified {@link AccountErrorCode} — and
 * `fallback` for everything else. Never the raw `Error.message` of an
 * arbitrary failure: transport and runtime internals ("All fibers interrupted
 * without error", "socket hang up") are not copy, and rendering them taught
 * us that the hard way.
 */
export function accountErrorMessage(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const candidate = error as { _tag?: unknown; code?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
  if (message.length === 0) return fallback;

  const trusted =
    (typeof candidate._tag === "string" && TRUSTED_ACCOUNT_ERROR_TAGS.has(candidate._tag)) ||
    (typeof candidate.code === "string" && Schema.is(AccountErrorCodeSchema)(candidate.code));
  return trusted ? message : fallback;
}

/** Strips the visual @-prefix and anything a handle can never contain. */
export function sanitizeHandleInput(value: string): string {
  return value
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30);
}

/**
 * The live format check for the onboarding handle field, matching the
 * contracts schema exactly (3–30 chars, lowercase alphanumeric + hyphens,
 * alphanumeric at both ends). Returns the message to show, or null when valid.
 */
export function handleFormatError(handle: string): string | null {
  if (handle.length === 0) return "Pick a handle.";
  // Assigned first so the guard doesn't narrow `handle` to the branded type.
  const valid: boolean = Schema.is(AccountProfileHandle)(handle);
  if (valid) return null;
  if (handle.length < 3) return "Handles need at least 3 characters.";
  return "Use lowercase letters, numbers, and hyphens; start and end with a letter or number.";
}

/** First grapheme of the display name, uppercased — the avatar fallback glyph. */
export function accountInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** First name only; the sidebar footer row has one line to spend. */
export function accountFirstName(me: AccountMe): string {
  const display = me.profile?.displayName ?? me.name;
  return display.trim().split(/\s+/)[0] ?? display;
}

export function publicProfileUrl(handle: string): string {
  return `https://trysynara.com/profile/@${handle}`;
}

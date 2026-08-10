// FILE: accountLogic.ts
// Purpose: Pure helpers for the account sign-in/onboarding UI — error-code
// classification of RPC failures and handle/display derivations.
// Layer: Web account feature logic (no I/O).

import { AccountProfileHandle, type AccountErrorCode, type AccountMe } from "@synara/contracts";
import { Schema } from "effect";

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

export function accountErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
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

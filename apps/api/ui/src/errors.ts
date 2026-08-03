// FILE: ui/src/errors.ts
// Purpose: One way to read a human message out of a BetterAuth client error.
// Layer: Account UI data access
// Depends on: nothing.

/**
 * Core BetterAuth endpoints report `message`, while the OAuth-shaped
 * device-authorization endpoints report `error_description`. Pages should not
 * have to know which family an endpoint belongs to.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const record = error as Record<string, unknown>;
  const description = record.error_description;
  if (typeof description === "string" && description.length > 0) return description;
  const message = record.message;
  if (typeof message === "string" && message.length > 0) return message;
  return fallback;
}

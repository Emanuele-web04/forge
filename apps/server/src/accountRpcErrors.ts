// FILE: accountRpcErrors.ts
// Purpose: Map account-session failures to WsRpcError for the account RPC handlers.
// Layer: server RPC error mapping
// Why: `Effect.tryPromise` wraps every rejection in `Cause.UnknownError`, so without
// unwrapping the AccountApiError underneath, the client would only ever see the
// generic fallback message — and never the `AccountErrorCode` the UI branches on
// (`invalid_verification_code`, `handle_taken`, ...).

import { WsRpcError } from "@synara/contracts";
import { AccountApiError } from "@synara/shared/account";
import { Cause, Schema } from "effect";

import { PairingVerificationError } from "./hostSecrets/coordinator";

/** The original rejection from an `Effect.tryPromise`d account-session call. */
export function unwrapTryPromiseError(cause: unknown): unknown {
  return Cause.isUnknownError(cause) && cause.cause !== undefined ? cause.cause : cause;
}

/**
 * The mapping for ordinary account RPCs. An `AccountApiError` keeps its message
 * and carries its `AccountErrorCode` on `code`; anything else keeps the
 * pre-existing `toWsRpcError` shape via the caller's fallback.
 */
export function toAccountWsRpcError(rawCause: unknown, fallbackMessage: string): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  if (Schema.is(WsRpcError)(cause)) return cause;
  if (cause instanceof AccountApiError) {
    return new WsRpcError({
      message: cause.message.length > 0 ? cause.message : fallbackMessage,
      code: cause.code,
    });
  }
  return new WsRpcError({
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage,
    cause,
  });
}

/**
 * The mapping for RPCs whose *request* carried a credential (the emailed OTP
 * code). Same classification as {@link toAccountWsRpcError}, but nothing
 * derived from the request may ride along: no `cause` is ever attached (a
 * fetch error can quote the request body, and anything attached here is
 * serialized to the client and may be logged on the way), and an unrecognized
 * failure is reduced to the fallback message rather than its own — the
 * account service has already worded every failure that is safe to show.
 */
export function toSensitiveWsRpcError(rawCause: unknown, fallbackMessage: string): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  if (Schema.is(WsRpcError)(cause)) {
    return new WsRpcError({ message: cause.message, code: cause.code });
  }
  if (cause instanceof AccountApiError) {
    return new WsRpcError({
      message: cause.message.length > 0 ? cause.message : fallbackMessage,
      code: cause.code,
    });
  }
  return new WsRpcError({ message: fallbackMessage });
}

/**
 * The Sync-Key confirmation request contains a short credential, so it keeps
 * the sensitive mapper's no-cause rule. Its coordinator error has one extra
 * safe field the UI needs: the server-owned number of attempts still allowed.
 */
export function toPairingVerificationWsRpcError(
  rawCause: unknown,
  fallbackMessage: string,
): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  if (cause instanceof PairingVerificationError) {
    return new WsRpcError({
      message: cause.message.length > 0 ? cause.message : fallbackMessage,
      code: "sync_key_verification_failed",
      remainingAttempts: cause.remainingAttempts,
    });
  }
  return toSensitiveWsRpcError(cause, fallbackMessage);
}

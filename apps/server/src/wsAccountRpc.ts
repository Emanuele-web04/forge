// FILE: wsAccountRpc.ts
// Purpose: The account RPC handlers, as one owner-guarded unit.
// Layer: server RPC handlers
//
// Extracted from wsRpc.ts so the owner boundary is enumerable: every handler
// built here runs behind `requireOwnerRole`, and the tests iterate this
// module's keys — a new account RPC added here is guarded and covered by
// construction, while one added anywhere else would not type-check against
// the RPC group.
//
// The account is owner state, entirely: the credential file, sign-in,
// sign-out, status, and profile all describe the machine's account, and a
// paired client-role session must neither read nor replace any of it. The
// guard runs BEFORE the handler effect is built, so a refused session causes
// no credential-file read or write.

import { WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect } from "effect";

import { toAccountWsRpcError, toSensitiveWsRpcError } from "./accountRpcErrors";
import type { AccountSession } from "./accountSession";
import type { OpenError } from "./open";
import { requireOwnerRole } from "./wsOwnerOnly";

export interface AccountRpcHandlerDeps {
  readonly accountSession: AccountSession;
  readonly openBrowser: (url: string) => Effect.Effect<void, OpenError>;
}

/**
 * `rpcEffect` for the account handlers: an `AccountApiError` keeps its
 * message and carries its `AccountErrorCode` as `code`, which the web UI
 * branches on (`handle_taken` under the handle field, an expired device
 * code offering a retry, ...). The guard runs first and the effect is built
 * lazily, so a refused session performs none of the handler's work.
 */
const ownerAccountRpc = <A, E, R>(make: () => Effect.Effect<A, E, R>, fallbackMessage: string) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      make().pipe(Effect.mapError((cause) => toAccountWsRpcError(cause, fallbackMessage))),
    ),
  );

/**
 * {@link ownerAccountRpc} for handlers whose request carried a credential
 * (the emailed OTP code, or the verification code + pending token).
 *
 * Same classification, minus the `cause`: the ordinary path attaches the
 * original error, which for a failed credential call is an object graph
 * built from a request that contained the secret — a fetch error can quote
 * the request, and anything attached here is serialized to the client and
 * may be logged on the way. The account service has already turned the real
 * reason into a message and code (`invalid_verification_code`, ...), so
 * those are all that is worth keeping.
 */
const ownerSensitiveAccountRpc = <A, E, R>(
  make: () => Effect.Effect<A, E, R>,
  fallbackMessage: string,
) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      make().pipe(Effect.mapError((cause) => toSensitiveWsRpcError(cause, fallbackMessage))),
    ),
  );

export function makeAccountRpcHandlers({ accountSession, openBrowser }: AccountRpcHandlerDeps) {
  return {
    [WS_METHODS.accountStatus]: () =>
      ownerAccountRpc(
        () => Effect.promise(() => accountSession.status()),
        "Failed to read the account session",
      ),
    // The send carries only the address — no credential — but shares the
    // sensitive mapping so no upstream cause can ride to the wire.
    [WS_METHODS.accountSendOtp]: (input: Parameters<AccountSession["sendOtp"]>[0]) =>
      ownerSensitiveAccountRpc(
        () => Effect.tryPromise(() => accountSession.sendOtp(input)),
        "Could not send the code. Try again in a minute.",
      ),
    // The payload carries the emailed code — a credential — so it goes
    // through the sensitive mapping rather than the ordinary one: the
    // failure is reduced to a message and the cause is dropped, so no
    // object graph derived from the request can reach the wire or a log.
    [WS_METHODS.accountAuthenticateOtp]: (
      input: Parameters<AccountSession["authenticateOtp"]>[0],
    ) =>
      ownerSensitiveAccountRpc(
        () => Effect.tryPromise(() => accountSession.authenticateOtp(input)),
        "Could not sign in. Check the code and try again.",
      ),
    [WS_METHODS.accountBeginSso]: (input: Parameters<AccountSession["beginSso"]>[0]) =>
      ownerAccountRpc(
        () => Effect.tryPromise(() => accountSession.beginSso(input)),
        "Failed to start sign-in",
      ),
    // Runs until the browser comes back, so it deliberately has no timeout
    // of its own; the loopback listener's own deadline bounds it, and the
    // client is told not to time it out either. A client that disconnects
    // mid-flight loses nothing: the credentials are persisted here before
    // this answers, and `account.status` recovers them.
    [WS_METHODS.accountCompleteSso]: (input: Parameters<AccountSession["completeSso"]>[0]) =>
      ownerAccountRpc(
        () => Effect.tryPromise(() => accountSession.completeSso(input)),
        "Failed to finish signing in",
      ),
    [WS_METHODS.accountCancelSso]: (input: Parameters<AccountSession["cancelSso"]>[0]) =>
      ownerAccountRpc(
        () => Effect.tryPromise(() => accountSession.cancelSso(input)),
        "Failed to cancel the sign-in",
      ),
    [WS_METHODS.accountUpdateProfile]: (input: Parameters<AccountSession["updateProfile"]>[0]) =>
      ownerAccountRpc(
        () => Effect.tryPromise(() => accountSession.updateProfile(input)),
        "Failed to save your profile",
      ),
    [WS_METHODS.accountSignOut]: () =>
      ownerAccountRpc(
        () => Effect.tryPromise(() => accountSession.signOut()),
        "Failed to sign out",
      ),
    [WS_METHODS.accountOpenVerificationUrl]: (input: { readonly url: string }) =>
      ownerAccountRpc(
        () =>
          Effect.gen(function* () {
            // Only an authorize URL this server issued from an SSO attempt.
            // Without this the method would be an arbitrary-URL opener
            // reachable by anyone who can reach the WebSocket.
            const allowed = yield* Effect.promise(() =>
              accountSession.isVerificationUrlAllowed(input.url),
            );
            if (!allowed) {
              return yield* Effect.fail(
                new WsRpcError({
                  message: "That link is not a sign-in verification URL from this server.",
                }),
              );
            }
            yield* openBrowser(input.url);
          }),
        "Failed to open the sign-in page",
      ),
  };
}

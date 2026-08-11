// The account RPC owner boundary: every account method is owner-only —
// reads included — because the machine account is owner state, and a paired
// client-role session must neither read nor replace it. These tests iterate
// the handler map, so a newly added account RPC is covered by construction.
import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { AccountSession } from "./accountSession";
import { provideWsConnectionSession } from "./wsConnectionSessions";
import { makeAccountRpcHandlers } from "./wsAccountRpc";

const SAMPLE_INPUTS: Record<string, unknown> = {
  [WS_METHODS.accountStatus]: undefined,
  [WS_METHODS.accountSendOtp]: { email: "ada@example.com" },
  [WS_METHODS.accountAuthenticateOtp]: { email: "ada@example.com", code: "654321" },
  [WS_METHODS.accountVerifyEmail]: {
    code: "654321",
    pendingAuthenticationToken: "pat_test",
    email: "ada@example.com",
  },
  [WS_METHODS.accountResendVerificationEmail]: { emailVerificationId: "ev_test" },
  [WS_METHODS.accountBeginSignIn]: undefined,
  [WS_METHODS.accountCompleteSignIn]: { deviceCode: "dc_test" },
  [WS_METHODS.accountBeginSso]: { provider: "google" },
  [WS_METHODS.accountCompleteSso]: { ssoId: "sso_test" },
  [WS_METHODS.accountCancelSso]: { ssoId: "sso_test" },
  [WS_METHODS.accountUpdateProfile]: {
    handle: "ada",
    displayName: "Ada",
    avatarColor: "emerald",
  },
  [WS_METHODS.accountSignOut]: undefined,
  [WS_METHODS.accountOpenVerificationUrl]: { url: "https://auth.example.com/device?code=x" },
};

/**
 * An account session whose every method records the call. Anything a
 * client-role request managed to reach would show up as a recorded call —
 * including the status read, which is the method most tempting to leave
 * unguarded.
 */
function spySession(): { session: AccountSession; calls: () => string[] } {
  const calls: string[] = [];
  const record =
    <A>(name: string, result: A) =>
    (..._args: unknown[]) => {
      calls.push(name);
      return Promise.resolve(result);
    };
  const session: AccountSession = {
    status: record("status", { state: "signed-out" as const }),
    sendOtp: record("sendOtp", { email: "ada@example.com", expiresAt: "2026-01-01T00:00:00Z" }),
    authenticateOtp: record("authenticateOtp", { state: "signed-out" as const }),
    verifyEmail: record("verifyEmail", { state: "signed-out" as const }),
    resendVerificationEmail: record("resendVerificationEmail", undefined),
    beginSignIn: record("beginSignIn", {
      deviceCode: "dc_test",
      userCode: "ABCD-EFGH",
      verificationUriComplete: "https://auth.example.com/device?code=x",
      expiresIn: 600,
      interval: 5,
    }),
    completeSignIn: record("completeSignIn", { state: "signed-out" as const }),
    beginSso: record("beginSso", {
      ssoId: "sso_test",
      authorizeUrl: "https://auth.example.com/authorize?provider=GoogleOAuth",
    }),
    completeSso: record("completeSso", { state: "signed-out" as const }),
    cancelSso: record("cancelSso", undefined),
    updateProfile: record("updateProfile", {
      id: "user_1",
      name: "Ada",
      email: "ada@example.com",
      organization: { id: "org_1", name: "Workspace" },
      profile: null,
    }),
    signOut: record("signOut", undefined),
    isVerificationUrlAllowed: record("isVerificationUrlAllowed", true),
  };
  return { session, calls: () => calls };
}

const CLIENT_SESSION = {
  role: "client" as const,
  attachmentPrincipal: { ownerKind: "session" as const, ownerId: "paired-client" },
};

const OWNER_SESSION = {
  role: "owner" as const,
  attachmentPrincipal: { ownerKind: "session" as const, ownerId: "owner" },
};

function handlersFor(session: AccountSession, openBrowser = vi.fn(() => Effect.void)) {
  return makeAccountRpcHandlers({ accountSession: session, openBrowser });
}

describe("account RPC owner boundary", () => {
  const methodNames = Object.keys(handlersFor(spySession().session));

  it("covers every account WS method", () => {
    const accountMethods = Object.values(WS_METHODS).filter((method) =>
      method.startsWith("account."),
    );
    expect(methodNames.toSorted()).toEqual(accountMethods.toSorted());
  });

  it.each(methodNames)(
    "refuses a client-role session on %s without touching the session",
    async (method) => {
      const { session, calls } = spySession();
      const openBrowser = vi.fn(() => Effect.void);
      const handlers = handlersFor(session, openBrowser) as unknown as Record<
        string,
        (input?: unknown) => Effect.Effect<unknown, { message: string }>
      >;
      const handler = handlers[method];
      if (!handler) throw new Error(`no handler for ${method}`);

      const result = await Effect.runPromise(
        provideWsConnectionSession(
          handler(SAMPLE_INPUTS[method]).pipe(Effect.flip),
          CLIENT_SESSION,
        ),
      );

      expect(result.message).toMatch(/owner authorization/i);
      // The guard must fire before any handler work: no credential-file read
      // or write can have happened because the session was never invoked.
      expect(calls()).toEqual([]);
      expect(openBrowser).not.toHaveBeenCalled();
    },
  );

  // The default role for a connection with no registered session is
  // "client", so an unregistered connection is refused the same way.
  it("refuses a connection with no registered session", async () => {
    const { session, calls } = spySession();
    const handlers = handlersFor(session) as unknown as Record<
      string,
      (input?: unknown) => Effect.Effect<unknown, { message: string }>
    >;
    const statusHandler = handlers[WS_METHODS.accountStatus];
    if (!statusHandler) throw new Error("no status handler");
    const result = await Effect.runPromise(
      provideWsConnectionSession(statusHandler().pipe(Effect.flip), undefined),
    );
    expect(result.message).toMatch(/owner authorization/i);
    expect(calls()).toEqual([]);
  });

  it.each(methodNames)("admits an owner-role session on %s", async (method) => {
    const { session, calls } = spySession();
    const handlers = handlersFor(session) as unknown as Record<
      string,
      (input?: unknown) => Effect.Effect<unknown, unknown>
    >;
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);

    await Effect.runPromise(
      provideWsConnectionSession(handler(SAMPLE_INPUTS[method]), OWNER_SESSION),
    );

    expect(calls().length).toBeGreaterThan(0);
  });
});

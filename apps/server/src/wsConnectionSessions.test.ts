import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  CurrentManagedAttachmentPrincipal,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
} from "./managedAttachmentPrincipal.ts";
import {
  CurrentWsSessionRole,
  makeWsConnectionSessions,
  provideWsConnectionSession,
  type WsConnectionSession,
} from "./wsConnectionSessions.ts";

const OWNER_SESSION: WsConnectionSession = {
  role: "owner",
  attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
};

describe("WsConnectionSessions", () => {
  it("registers sessions for the connection scope and forgets them on close", async () => {
    const sessions = await Effect.runPromise(makeWsConnectionSessions);
    const scope = await Effect.runPromise(Scope.make());
    const key = await Effect.runPromise(Scope.provide(sessions.register(OWNER_SESSION), scope));

    expect(sessions.lookup(key)).toEqual(OWNER_SESSION);
    expect(sessions.lookup(undefined)).toBeUndefined();
    expect(sessions.lookup("unknown-key")).toBeUndefined();

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(sessions.lookup(key)).toBeUndefined();
  });

  it("issues unguessable, unique keys per connection", async () => {
    const sessions = await Effect.runPromise(makeWsConnectionSessions);
    const scope = await Effect.runPromise(Scope.make());
    const first = await Effect.runPromise(Scope.provide(sessions.register(OWNER_SESSION), scope));
    const second = await Effect.runPromise(
      Scope.provide(
        sessions.register({
          role: "client",
          attachmentPrincipal: { ownerKind: "session", ownerId: "session-1" },
        }),
        scope,
      ),
    );

    expect(first).not.toEqual(second);
    expect(sessions.lookup(second)?.role).toBe("client");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("runs connection cleanup once and rejects registration after close", async () => {
    const sessions = await Effect.runPromise(makeWsConnectionSessions);
    const scope = await Effect.runPromise(Scope.make());
    const key = await Effect.runPromise(Scope.provide(sessions.register(OWNER_SESSION), scope));
    const completed: string[] = [];
    const cleanup = () => completed.push("closed");
    expect(sessions.onClose(key, cleanup)).toBe(true);
    expect(sessions.onClose(key, cleanup)).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(completed).toEqual(["closed"]);
    expect(sessions.onClose(key, cleanup)).toBe(false);
    expect(sessions.onClose("unknown", cleanup)).toBe(false);
  });

  it("provides role and attachment principal to the wrapped effect", async () => {
    const read = Effect.gen(function* () {
      return {
        role: yield* CurrentWsSessionRole,
        principal: yield* CurrentManagedAttachmentPrincipal,
      };
    });

    const withSession = await Effect.runPromise(
      provideWsConnectionSession(read, {
        role: "owner",
        attachmentPrincipal: { ownerKind: "session", ownerId: "session-9" },
      }),
    );
    expect(withSession).toEqual({
      role: "owner",
      principal: { ownerKind: "session", ownerId: "session-9" },
    });

    // Without a session the conservative defaults must apply.
    const withoutSession = await Effect.runPromise(provideWsConnectionSession(read, undefined));
    expect(withoutSession).toEqual({
      role: "client",
      principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
    });
  });
});

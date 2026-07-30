// Proves the admission middleware is the single enforcement choke point: the
// authorization table is consulted for every RPC, and a rejected method never
// reaches its handler. A mutation that drops the authorizeWsMethod call, or
// that defaults an unresolved connection session to "owner", fails here.
import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { Rpc } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal";
import type { RemoteAccessDeployment } from "./remoteAccessPolicy";
import {
  WS_CONNECTION_SESSION_HEADER,
  type WsConnectionSession,
  type WsSessionRole,
} from "./wsConnectionSessions";
import { makeWsAdmissionMiddleware } from "./wsRpc";

const loopback: RemoteAccessDeployment = {
  host: "127.0.0.1",
  publicUrl: undefined,
  allowInsecureRemote: false,
};
const remote: RemoteAccessDeployment = {
  host: "0.0.0.0",
  publicUrl: undefined,
  allowInsecureRemote: false,
};

const SESSION_KEY = "connection-session-key";

function runMiddleware(input: {
  readonly method: string;
  readonly role?: WsSessionRole;
  readonly config: RemoteAccessDeployment;
  readonly registerSession?: boolean;
  readonly buildSkewed?: boolean;
}) {
  let handlerRan = false;
  const session: WsConnectionSession = {
    role: input.role ?? "client",
    attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
    buildSkewed: input.buildSkewed ?? false,
  };
  const middleware = makeWsAdmissionMiddleware({
    // Pass the guarded effect through untouched so the test observes
    // authorization alone, not concurrency admission.
    admission: { guard: (_clientId, _method, effect) => effect },
    connectionSessions: {
      lookup: (key) =>
        key === SESSION_KEY && input.registerSession !== false ? session : undefined,
    },
    config: input.config,
  });
  const rpc = Rpc.make(input.method, {
    payload: Schema.Struct({}),
    success: Schema.String,
  }) as unknown as Rpc.AnyWithProps;
  const effect = Effect.sync(() => {
    handlerRan = true;
    return "ok";
  });
  const exit = Effect.runSyncExit(
    middleware(effect as never, {
      clientId: 1,
      requestId: 1n as never,
      rpc,
      payload: {},
      headers: Headers.fromInput({ [WS_CONNECTION_SESSION_HEADER]: SESSION_KEY }),
    }) as Effect.Effect<unknown, WsRpcError>,
  );
  return { exit, handlerRan };
}

describe("ws admission middleware authorization", () => {
  it("runs an unrestricted method for a paired client", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.gitStatus,
      config: remote,
    });
    expect(exit._tag).toBe("Success");
    expect(handlerRan).toBe(true);
  });

  it.each([
    WS_METHODS.serverUpdateSettings,
    WS_METHODS.serverUpdateProvider,
    WS_METHODS.serverUpsertKeybinding,
    WS_METHODS.serverStopLocalServer,
  ])("refuses %s for a non-owner without invoking the handler", (method) => {
    const { exit, handlerRan } = runMiddleware({ method, role: "client", config: loopback });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("refuses external MCP management on a remote-reachable bind even for an owner", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.serverCreateExternalMcpIntegration,
      role: "owner",
      config: remote,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("treats an unresolved connection session as a non-owner client", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.serverUpdateSettings,
      role: "owner",
      config: loopback,
      registerSession: false,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  // Server-side skew enforcement. The client refuses these too, but that guard
  // lives in code the client controls; this is what actually stops an older or
  // hand-rolled client from writing cross-version.
  it("refuses a mutation from a version-skewed client, even an owner", () => {
    const { exit, handlerRan } = runMiddleware({
      method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      role: "owner",
      config: loopback,
      buildSkewed: true,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("still admits reads from a version-skewed client", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.gitStatus,
      config: loopback,
      buildSkewed: true,
    });
    expect(exit._tag).toBe("Success");
    expect(handlerRan).toBe(true);
  });

  it("treats an unresolved session as skewed and refuses its mutations", () => {
    const { exit, handlerRan } = runMiddleware({
      method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      role: "owner",
      config: loopback,
      registerSession: false,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  // Default deny: an unregistered method must not reach its handler just
  // because nobody remembered to classify it.
  it("refuses an unregistered method for a client session", () => {
    const { exit, handlerRan } = runMiddleware({
      method: "server.someFutureUnclassifiedMethod",
      role: "client",
      config: loopback,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("admits an owner-only method for a registered owner session", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.serverUpdateSettings,
      role: "owner",
      config: loopback,
    });
    expect(exit._tag).toBe("Success");
    expect(handlerRan).toBe(true);
  });
});

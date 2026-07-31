// Proves the admission middleware is the single enforcement choke point: the
// authorization table is consulted for every RPC, and a rejected method never
// reaches its handler. A mutation that drops the authorizeWsMethod call, or
// that defaults an unresolved connection session to "owner", fails here.
import {
  ORCHESTRATION_WS_METHODS,
  WS_COMPATIBILITY_QUERY,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { Rpc, RpcSchema } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal";
import { resolveWsUpgradeBuildSkew } from "./wsRpc";
import { version as serverBuild } from "../package.json" with { type: "json" };
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
  readonly stream?: boolean;
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
  // Streaming rpcs take a different branch in the middleware — authorization
  // runs first, then only NON-stream rpcs are wrapped in `admission.guard`. The
  // harness built non-stream rpcs only, so the whole stream path was unpinned
  // while the code comment claimed central enforcement covers "including
  // streaming ones". Streams are where it matters most: subscribeThread and
  // gitRunStackedAction are streams.
  const rpc = (input.stream === true
    ? Rpc.make(input.method, {
        payload: Schema.Struct({}),
        success: RpcSchema.Stream(Schema.String, Schema.Never),
      })
    : Rpc.make(input.method, {
        payload: Schema.Struct({}),
        success: Schema.String,
      })) as unknown as Rpc.AnyWithProps;
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

/**
 * The upgrade-URL classification that produces `buildSkewed` for the session
 * the middleware above reads. Every other skew test injects that flag directly,
 * so this step — the only server-side classification there is — was unpinned:
 * making it return `false` left 92 tests green across six files.
 */
/**
 * The same authorization decisions, on the streaming branch. The middleware
 * runs `authorizeWsMethod` before it decides whether to wrap in
 * `admission.guard`, so a stream must be refused on exactly the same terms —
 * but nothing proved that, because the harness only ever built non-stream rpcs.
 */
describe("ws admission middleware authorization for streaming rpcs", () => {
  it("admits a client-allowed stream", () => {
    const { exit, handlerRan } = runMiddleware({
      method: ORCHESTRATION_WS_METHODS.subscribeThread,
      role: "client",
      config: remote,
      stream: true,
    });
    expect(exit._tag).toBe("Success");
    expect(handlerRan).toBe(true);
  });

  it("refuses an owner-only stream for a non-owner", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.serverStopLocalServer,
      role: "client",
      config: loopback,
      stream: true,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("refuses an unclassified stream for a client", () => {
    const { exit, handlerRan } = runMiddleware({
      method: "orchestration.someFutureStream",
      role: "client",
      config: loopback,
      stream: true,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("refuses a mutating stream from a skewed session", () => {
    const { exit, handlerRan } = runMiddleware({
      method: WS_METHODS.gitRunStackedAction,
      role: "owner",
      config: loopback,
      buildSkewed: true,
      stream: true,
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });

  it("still admits a read-only stream from a skewed session", () => {
    const { exit, handlerRan } = runMiddleware({
      method: ORCHESTRATION_WS_METHODS.subscribeThread,
      role: "owner",
      config: loopback,
      buildSkewed: true,
      stream: true,
    });
    expect(exit._tag).toBe("Success");
    expect(handlerRan).toBe(true);
  });
});

describe("ws upgrade build-skew classification", () => {
  const paramsFor = (clientBuild: string) =>
    new URLSearchParams({ [WS_COMPATIBILITY_QUERY.clientBuild]: clientBuild });

  it("does not classify a matching build as skewed", () => {
    expect(resolveWsUpgradeBuildSkew(paramsFor(serverBuild))).toBe(false);
  });

  it("classifies a mismatched build as skewed", () => {
    const [major = "0", minor = "0"] = serverBuild.split(".");
    expect(resolveWsUpgradeBuildSkew(paramsFor(`${Number(major) + 1}.${minor}.0`))).toBe(true);
  });

  it("classifies a missing or unparseable client build as skewed", () => {
    expect(resolveWsUpgradeBuildSkew(new URLSearchParams())).toBe(true);
    expect(resolveWsUpgradeBuildSkew(paramsFor("test-client"))).toBe(true);
  });

  it("refuses a mutation for the session such a classification produces", () => {
    const { exit, handlerRan } = runMiddleware({
      method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      role: "owner",
      config: loopback,
      buildSkewed: resolveWsUpgradeBuildSkew(paramsFor("test-client")),
    });
    expect(exit._tag).toBe("Failure");
    expect(handlerRan).toBe(false);
  });
});

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

import { WS_FEATURE_PATH } from "@synara/contracts";
import { Duration, Effect } from "effect";
import WebSocket, { type RawData } from "ws";

import type { SessionCredentialServiceShape } from "../auth/Services/SessionCredentialService";
import type { RelaySocket } from "../relayDial";
import { makeCurrentWsFeatureCompatibilitySearchParams } from "../wsCompatibility";
import serverPackageJson from "../../package.json" with { type: "json" };

export interface LocalRpcBridgeOptions {
  readonly listeningPort: number;
  readonly sessions: SessionCredentialServiceShape;
}

/**
 * A close code safe to hand to `ws.close()`. The reserved codes a peer never
 * sends on the wire but the library REPORTS locally — 1005 (no status), 1006
 * (abnormal, i.e. any TCP reset or relay restart), 1015 (TLS failure) — make
 * `close()` throw synchronously from inside a `close` listener. With no
 * uncaughtException handler in this process, forwarding one verbatim would
 * take the whole host down whenever a bridged session dropped abnormally.
 */
function forwardableCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return 1001;
  return code >= 1000 && code <= 4999 ? code : 1001;
}

/** Proxies an authenticated remote socket through the ordinary local `/ws` admission path. */
export async function bridgeRemoteSocketToLocalRpc(
  external: RelaySocket,
  peer: { readonly userId: string; readonly expiresAtSeconds: number },
  options: LocalRpcBridgeOptions,
): Promise<void> {
  const ttlMs = Math.max(1_000, peer.expiresAtSeconds * 1_000 - Date.now());
  const issued = await Effect.runPromise(
    options.sessions.issue({
      ttl: Duration.millis(ttlMs),
      subject: peer.userId,
      method: "bearer-session-token",
      role: "client",
      client: { label: "Synara remote device", deviceType: "unknown" },
    }),
  );
  const websocketToken = await Effect.runPromise(
    options.sessions.issueWebSocketToken(issued.sessionId, { ttl: Duration.millis(ttlMs) }),
  );
  const search = makeCurrentWsFeatureCompatibilitySearchParams(serverPackageJson.version);
  search.set("wsToken", websocketToken.token);
  const internal = new WebSocket(
    `ws://127.0.0.1:${options.listeningPort}${WS_FEATURE_PATH}?${search.toString()}`,
    { perMessageDeflate: true },
  );
  const pending: RawData[] = [];
  let opened = false;
  const forwardExternal = (data: RawData) => {
    if (!opened) pending.push(data);
    else if (internal.readyState === WebSocket.OPEN) internal.send(data);
  };
  external.on("message", forwardExternal);

  await new Promise<void>((resolve, reject) => {
    internal.once("open", () => {
      opened = true;
      for (const data of pending.splice(0)) internal.send(data);
      resolve();
    });
    internal.once("error", reject);
  });
  internal.on("message", (data) => {
    if (external.readyState === WebSocket.OPEN) external.send(data as Uint8Array);
  });
  internal.on("close", (code, reason) =>
    external.close(forwardableCloseCode(code), reason.toString()),
  );
  external.on("close", (code, reason) => {
    if (internal.readyState === WebSocket.OPEN || internal.readyState === WebSocket.CONNECTING) {
      internal.close(forwardableCloseCode(code), reason.toString());
    }
    void Effect.runPromise(options.sessions.revoke(issued.sessionId)).catch(() => {});
  });
}

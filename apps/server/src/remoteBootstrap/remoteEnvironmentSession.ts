// FILE: remoteEnvironmentSession.ts
// Purpose: Compose the pieces into one reversible operation — open the tunnel,
//          verify the handshake through it, publish the environment to the
//          proxy — such that a failure at ANY point leaves nothing behind.
// Layer: Server / remote broker
// Exports: openRemoteEnvironmentSession, RemoteEnvironmentSession
//
// The invariant this file exists to hold
// --------------------------------------
// An environment is registered with the proxy ONLY after the handshake passed.
// Publishing first and verifying after would open a window in which the browser
// can reach an unverified server, and there is no length of window that is
// acceptable for that. So the order is fixed: tunnel, verify, publish — and
// every early exit unwinds exactly what it got through.
//
// Teardown is the other half. `close()` retracts the environment BEFORE tearing
// down the tunnel, because the reverse order leaves the proxy briefly holding a
// registration whose upstream port is already dead — every request through it
// answering 502 instead of 404.

import type { EnvironmentId } from "@synara/contracts";
import type { RemoteHostConfig } from "@synara/contracts";

import {
  publishProxiedEnvironment,
  retractProxiedEnvironment,
} from "../environmentProxyRegistry";
import { probeHandshakeOverTunnel } from "./handshakeProbe";
import {
  type ProvisioningClaim,
  type RemoteCredential,
  verifyProvisioningHandshake,
} from "./provisioningHandshake";
import { openSshTunnel, type SshTunnel } from "./sshTunnel";

export class RemoteEnvironmentSessionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RemoteEnvironmentSessionError";
  }
}

export interface RemoteEnvironmentSession {
  readonly environmentId: EnvironmentId;
  readonly localPort: number;
  /**
   * Retracts the environment and tears down the tunnel, in that order.
   * Idempotent; safe to call from a failure path.
   */
  close(): Promise<void>;
}

export interface OpenRemoteEnvironmentSessionInput {
  readonly config: RemoteHostConfig;
  readonly environmentId: EnvironmentId;
  readonly credential: RemoteCredential;
  /** Version we activated. A server running anything else is refused. */
  readonly serverVersion: string;
  /** Port the remote server listens on, on the remote's own loopback. */
  readonly remotePort: number;
  readonly controlDirectory?: string | undefined;
  /**
   * Called when the tunnel dies on its own. The environment is retracted before
   * this fires, so by the time a caller sees it the proxy already 404s rather
   * than 502s.
   */
  readonly onLost?: (detail: string) => void;
  /** Test seams. */
  readonly openTunnel?: typeof openSshTunnel;
  readonly probeHandshake?: (input: {
    readonly localPort: number;
    readonly credential: RemoteCredential;
  }) => Promise<ProvisioningClaim>;
  readonly publish?: typeof publishProxiedEnvironment;
  readonly retract?: typeof retractProxiedEnvironment;
}

export async function openRemoteEnvironmentSession(
  input: OpenRemoteEnvironmentSessionInput,
): Promise<RemoteEnvironmentSession> {
  const publish = input.publish ?? publishProxiedEnvironment;
  const retract = input.retract ?? retractProxiedEnvironment;

  let published = false;
  let closing: Promise<void> | undefined;
  let tunnel: SshTunnel | undefined;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Retract FIRST. The reverse order leaves the proxy holding a
      // registration whose upstream is already gone, and every request through
      // it answers 502 — an error that reads like the remote misbehaving rather
      // than like an environment that is no longer here.
      if (published) {
        published = false;
        retract(input.environmentId);
      }
      await tunnel?.close();
    })();
    return closing;
  };

  tunnel = await (input.openTunnel ?? openSshTunnel)({
    config: input.config,
    remotePort: input.remotePort,
    ...(input.controlDirectory === undefined
      ? {}
      : { controlDirectory: input.controlDirectory }),
    onClosed: ({ expected, detail }) => {
      if (expected) return;
      // Unwind through the same path an explicit close takes, so a tunnel that
      // died and a tunnel we closed leave the process in the same state.
      void close();
      input.onLost?.(detail);
    },
  });

  try {
    const claim = await (input.probeHandshake ??
      ((probeInput) => probeHandshakeOverTunnel(probeInput)))({
      localPort: tunnel.localPort,
      credential: input.credential,
    });
    const verdict = verifyProvisioningHandshake({
      claim,
      expected: {
        environmentId: input.environmentId,
        serverVersion: input.serverVersion,
        credential: input.credential,
      },
    });
    if (!verdict.ok) {
      throw new RemoteEnvironmentSessionError(verdict.reason);
    }

    // ONLY NOW. Everything above had to pass for the browser to be allowed to
    // reach this server at all.
    publish({
      environmentId: input.environmentId,
      host: "127.0.0.1",
      port: tunnel.localPort,
      credential: input.credential.token,
    });
    published = true;
  } catch (cause) {
    // Unwinds the tunnel, and the registration if we somehow got that far.
    await close();
    throw cause;
  }

  return {
    environmentId: input.environmentId,
    localPort: tunnel.localPort,
    close,
  };
}

// FILE: environmentProxyRegistry.ts
// Purpose: The process-wide registry of proxiable environments, and the one
//          function allowed to publish a bootstrapped remote server to it.
// Layer: Server / environment proxy
// Exports: sharedEnvironmentProxyRegistry, publishProxiedEnvironment,
//          retractProxiedEnvironment, resetSharedEnvironmentProxyRegistry
//
// Deliberately ONE instance for the process. The registry is the proxy's
// authorization state: a second instance would mean an environment reachable
// through one code path and not another, which is precisely the kind of
// divergence that turns "default-deny" into "denied on the path someone
// remembered to check".

import type { EnvironmentId } from "@synara/contracts";

import {
  makeEnvironmentProxyRegistry,
  type EnvironmentProxyRegistry,
  type EnvironmentProxyUpstream,
} from "./environmentProxyTargets";

let shared: EnvironmentProxyRegistry | undefined;

export function sharedEnvironmentProxyRegistry(): EnvironmentProxyRegistry {
  shared ??= makeEnvironmentProxyRegistry();
  return shared;
}

/**
 * Makes a bootstrapped remote server reachable at `/env/<environmentId>/*`.
 *
 * The caller is the SSH broker: `host`/`port` must be the local end of a
 * forward it holds open, and `credential` the token minted during provisioning
 * (see remoteBootstrap/provisioningHandshake.ts). The registry re-checks the
 * loopback constraint itself rather than trusting this contract, because the
 * consequence of a mistake here is an open relay.
 */
export function publishProxiedEnvironment(upstream: EnvironmentProxyUpstream): void {
  sharedEnvironmentProxyRegistry().register(upstream);
}

/**
 * Removes an environment. Called when a tunnel is torn down for good.
 *
 * NOT called for a transient tunnel drop: the remote session keeps running and
 * the client reattaches by cursor once the forward is re-established, so
 * retracting on a blip would make a recoverable outage look like a deletion.
 */
export function retractProxiedEnvironment(environmentId: EnvironmentId): void {
  sharedEnvironmentProxyRegistry().unregister(environmentId);
}

/** Test seam: drops the process-wide registry. */
export function resetSharedEnvironmentProxyRegistry(): void {
  shared = undefined;
}

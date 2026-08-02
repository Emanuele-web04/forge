// FILE: environmentProxyTargets.ts
// Purpose: The authorization boundary of the `/env/:envId/*` proxy — which
//          upstreams exist, and whether the caller may reach them.
// Layer: Server / environment proxy
// Exports: EnvironmentProxyRegistry, makeEnvironmentProxyRegistry,
//          EnvironmentProxyUpstream, resolveEnvironmentProxyUpstream,
//          EnvironmentProxyResolution
//
// The proxy adds a new reachability surface to the local server, so the rule is
// DEFAULT-DENY and the set of reachable upstreams is a REGISTRY, never a
// function of the request. A path segment selects an entry; it can never
// describe one. There is no host, port, or scheme anywhere in the request that
// the proxy will honour — that is what makes "an environmentId in the path
// cannot address an unintended target" a structural property rather than a
// validation rule someone has to remember to run.
//
// Layered on top of, never instead of, the remote server's own policy-driven
// auth (Phase 1): the upstream still authenticates every request it receives.

import type { EnvironmentId } from "@synara/contracts";
import { parseEnvironmentProxyTarget } from "@synara/shared/environmentProxyPath";

import { isLoopbackHost } from "./startupAccess";

/**
 * One reachable environment.
 *
 * `host`/`port` are the LOCAL end of the SSH tunnel the broker holds open, not
 * the remote machine's address: the proxy only ever connects to loopback, and
 * `assertLoopbackUpstream` enforces that at registration time. A registry entry
 * pointing at an arbitrary internet host would turn this server into an open
 * relay reachable by anyone who can reach the local UI.
 */
export interface EnvironmentProxyUpstream {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly port: number;
  /**
   * Credential minted for this environment during provisioning, presented to
   * the upstream on every proxied request. Never logged; never derived from
   * anything the browser sent.
   */
  readonly credential: string;
}

export class EnvironmentProxyTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentProxyTargetError";
  }
}

/**
 * Refuses any upstream that is not on loopback.
 *
 * The tunnel's near end is always a loopback port we opened. Anything else is
 * either a misconfiguration or an attempt to make the local server fetch an
 * address the browser could not reach itself (SSRF), and there is no legitimate
 * case that needs it.
 */
export function assertLoopbackUpstream(host: string, port: number): void {
  if (!isLoopbackHost(host)) {
    throw new EnvironmentProxyTargetError(
      `Refusing to register environment upstream on non-loopback host ${host}; the proxy only forwards to a locally held tunnel.`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EnvironmentProxyTargetError(`Invalid environment upstream port ${port}.`);
  }
}

export type EnvironmentProxyResolution =
  | { readonly ok: true; readonly upstream: EnvironmentProxyUpstream; readonly target: string }
  | {
      readonly ok: false;
      /**
       * `bad-request` — the path is malformed or hostile; nothing was looked up.
       * `unknown-environment` — well-formed, but no such registered upstream.
       *
       * Both answer 404 to the client. They are distinguished for logs only:
       * telling a caller which environment ids exist is a disclosure the proxy
       * has no reason to make.
       */
      readonly reason: "bad-request" | "unknown-environment";
      readonly detail: string;
    };

export interface EnvironmentProxyRegistry {
  register(upstream: EnvironmentProxyUpstream): void;
  unregister(environmentId: EnvironmentId): void;
  get(environmentId: string): EnvironmentProxyUpstream | undefined;
  list(): readonly EnvironmentProxyUpstream[];
}

export function makeEnvironmentProxyRegistry(): EnvironmentProxyRegistry {
  const upstreams = new Map<string, EnvironmentProxyUpstream>();
  return {
    register(upstream) {
      assertLoopbackUpstream(upstream.host, upstream.port);
      upstreams.set(upstream.environmentId, upstream);
    },
    unregister(environmentId) {
      upstreams.delete(environmentId);
    },
    get(environmentId) {
      return upstreams.get(environmentId);
    },
    list() {
      return [...upstreams.values()];
    },
  };
}

/**
 * Parse, then look up. Both steps must succeed, and neither can be skipped by a
 * caller: this is the only exported way to turn a request target into an
 * upstream, so there is no path where a raw path segment reaches a socket.
 */
export function resolveEnvironmentProxyUpstream(input: {
  readonly registry: Pick<EnvironmentProxyRegistry, "get">;
  readonly requestTarget: string;
}): EnvironmentProxyResolution {
  const parsed = parseEnvironmentProxyTarget(input.requestTarget);
  if (!parsed.ok) {
    return { ok: false, reason: "bad-request", detail: parsed.reason };
  }
  const upstream = input.registry.get(parsed.environmentId);
  if (!upstream) {
    return { ok: false, reason: "unknown-environment", detail: parsed.environmentId };
  }
  return { ok: true, upstream, target: parsed.upstreamTarget };
}

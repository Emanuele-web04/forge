// FILE: remoteAccessPolicy.ts
// Purpose: Single source of truth for whether a Synara deployment is
//          remote-reachable and what that implies for authentication.
// Layer: Server security policy
// Exports: isRemoteReachableDeployment, isLocalOnlyDeployment,
//          requiresSessionAuthentication, normalizeHttpsPublicOrigin,
//          remoteAccessPolicyError

import type { ServerConfigShape } from "./config";
import { isLoopbackHost } from "./startupAccess";

/** The configuration fields that decide reachability from another machine. */
export type RemoteAccessDeployment = Pick<
  ServerConfigShape,
  "host" | "publicUrl" | "allowInsecureRemote"
>;

export type AuthenticatedDeployment = RemoteAccessDeployment & Pick<ServerConfigShape, "authToken">;

/**
 * A deployment is remote-reachable when its socket can be reached from another
 * machine, or when the operator declared that intent.
 *
 * `allowInsecureRemote` counts even on a loopback bind: it is an explicit
 * statement that remote traffic is expected (for example through a tunnel or a
 * forwarded port), so treating it as remote fails safe.
 */
export function isRemoteReachableDeployment(config: RemoteAccessDeployment): boolean {
  return (
    !isLoopbackHost(config.host) || config.publicUrl !== undefined || config.allowInsecureRemote
  );
}

/**
 * Local-only deployments are the only ones allowed to keep implicit-owner
 * behavior (no session credential, legacy query token, loopback-only routes).
 */
export function isLocalOnlyDeployment(config: RemoteAccessDeployment): boolean {
  return !isRemoteReachableDeployment(config);
}

/**
 * Enforcement is policy-driven, never coupled to `--auth-token` presence: a
 * remote-reachable deployment ALWAYS requires a real authenticated session.
 * A configured token can only add enforcement to an otherwise local-only
 * deployment; it can never remove it.
 */
export function requiresSessionAuthentication(config: AuthenticatedDeployment): boolean {
  // Trimmed to match `remoteAccessPolicyError` below, which also tests the
  // trimmed token. Config construction already normalizes whitespace away, so
  // this is defense in depth: if the two disagreed, a whitespace-only token
  // would be absent to the startup gate (loopback startup succeeds, no pairing
  // link printed) and present here (every request needs a session), locking a
  // loopback user out with no way back in.
  return isRemoteReachableDeployment(config) || Boolean(config.authToken?.trim());
}

export function normalizeHttpsPublicOrigin(publicUrl: URL): URL | null {
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username !== "" ||
    publicUrl.password !== "" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search !== "" ||
    publicUrl.hash !== ""
  ) {
    return null;
  }
  return new URL(publicUrl.origin);
}

/**
 * Startup gate: a remote-reachable deployment must refuse to serve rather than
 * boot into a socket nobody can be held accountable for. Returns an actionable
 * message, or null when the deployment may start.
 */
export function remoteAccessPolicyError(
  config: AuthenticatedDeployment & Pick<ServerConfigShape, "devUrl">,
): string | null {
  if (config.publicUrl && !normalizeHttpsPublicOrigin(config.publicUrl)) {
    return "SYNARA_PUBLIC_URL/--public-url must be an HTTPS root origin without credentials, path, query, or fragment (for example https://synara.example.com).";
  }
  const isRemoteBind = !isLoopbackHost(config.host);
  if (isLocalOnlyDeployment(config)) return null;
  if (!config.authToken?.trim()) {
    const credentialHint =
      " Remote clients still authenticate with a session credential from the one-time pairing link printed at startup; the token only marks the deployment as operator-managed.";
    return config.publicUrl
      ? `Refusing to publish Synara through SYNARA_PUBLIC_URL/--public-url without SYNARA_AUTH_TOKEN/--auth-token.${credentialHint}`
      : isRemoteBind
        ? `Refusing to bind Synara to non-loopback host ${config.host ?? "<unspecified>"} without SYNARA_AUTH_TOKEN/--auth-token.${credentialHint}`
        : `Refusing to enable SYNARA_ALLOW_INSECURE_REMOTE/--allow-insecure-remote without SYNARA_AUTH_TOKEN/--auth-token.${credentialHint}`;
  }
  if (config.devUrl) {
    return "Remote server binds cannot be combined with VITE_DEV_SERVER_URL/--dev-url yet; use a loopback host for development or run the built web UI for remote access.";
  }
  if (isRemoteBind && !config.publicUrl && !config.allowInsecureRemote) {
    return "Refusing plaintext remote access. Configure an HTTPS reverse-proxy origin with SYNARA_PUBLIC_URL/--public-url, or explicitly accept unencrypted LAN traffic with SYNARA_ALLOW_INSECURE_REMOTE/--allow-insecure-remote.";
  }
  return null;
}

// FILE: provisioningHandshake.ts
// Purpose: The gate a freshly bootstrapped remote server must pass before the
//          broker will expose it to a browser: it must be the environment we
//          provisioned, on the release we installed, answering with the
//          credential we minted.
// Layer: Server / remote broker
// Exports: RemoteCredential, mintRemoteCredential, redactCredential,
//          ProvisioningClaim, verifyProvisioningHandshake, HandshakeVerdict
//
// Phase 1 made auth policy-driven: a remote-reachable server refuses to boot
// without a credential path. The bootstrapper therefore MINTS one and installs
// it; it never expects to find an open socket. That inverts the usual failure
// mode — if the credential is missing, the remote server does not start, rather
// than starting unauthenticated.

import { randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits of entropy, base64url so it is safe in a file and a header. */
const CREDENTIAL_BYTES = 32;

export interface RemoteCredential {
  readonly token: string;
}

export function mintRemoteCredential(
  generate: (size: number) => Buffer = randomBytes,
): RemoteCredential {
  return { token: generate(CREDENTIAL_BYTES).toString("base64url") };
}

/**
 * The ONLY representation of a credential that is allowed anywhere near a log
 * line, an error message, or persisted broker state.
 *
 * Returns a fixed marker, not a prefix: even a few leading characters of a
 * token narrow an offline search, and there is no diagnostic question that a
 * token prefix answers better than the install path does.
 */
export function redactCredential(_credential: RemoteCredential | string | undefined): string {
  return "<redacted>";
}

/** What the remote server told us about itself. */
export interface ProvisioningClaim {
  readonly environmentId: string | undefined;
  readonly serverVersion: string | undefined;
  /**
   * Echo of the credential the remote accepted. Optional on the wire, but a
   * claim that omits it is rejected: see verifyProvisioningHandshake.
   */
  readonly acceptedToken: string | undefined;
  readonly authenticated: boolean;
}

export interface ProvisioningExpectation {
  readonly environmentId: string;
  readonly serverVersion: string;
  readonly credential: RemoteCredential;
}

export type HandshakeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Compare lengths separately; timingSafeEqual throws on a length mismatch,
  // and a thrown exception is itself an oracle if it escapes.
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * Default-deny: every claim must be present AND match. A missing field is a
 * failure, never a "can't tell, assume fine" — an unverified server would
 * otherwise be exposed to the browser on any probe hiccup.
 *
 * Failure reasons never include the expected or received credential.
 */
export function verifyProvisioningHandshake(input: {
  readonly claim: ProvisioningClaim;
  readonly expected: ProvisioningExpectation;
}): HandshakeVerdict {
  const { claim, expected } = input;
  if (!claim.authenticated) {
    return {
      ok: false,
      reason: "Remote server did not accept the provisioned credential.",
    };
  }
  if (!claim.environmentId) {
    return { ok: false, reason: "Remote server reported no environmentId." };
  }
  if (claim.environmentId !== expected.environmentId) {
    return {
      ok: false,
      reason: `Remote server reported environmentId ${claim.environmentId}, expected ${expected.environmentId}. Refusing to attach to a server we did not provision.`,
    };
  }
  if (!claim.serverVersion) {
    return { ok: false, reason: "Remote server reported no version." };
  }
  if (claim.serverVersion !== expected.serverVersion) {
    return {
      ok: false,
      reason: `Remote server reported version ${claim.serverVersion}, expected ${expected.serverVersion}. The activated release is not the one running.`,
    };
  }
  // Required, not optional. Making the comparison conditional on the field
  // being present would let the party being authenticated decide whether it
  // gets checked, simply by omitting it — and `authenticated` is self-reported
  // by that same party, so it is no backstop.
  if (claim.acceptedToken === undefined) {
    return { ok: false, reason: "Remote server did not echo the credential it accepted." };
  }
  if (!constantTimeEquals(claim.acceptedToken, expected.credential.token)) {
    return { ok: false, reason: "Remote server echoed a credential we did not provision." };
  }
  return { ok: true };
}

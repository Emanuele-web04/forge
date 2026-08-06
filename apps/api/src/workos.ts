// FILE: workos.ts
// Purpose: WorkOS AuthKit integration — access-token verification against the
// JWKS, user lookup, and the device authorization grant used by the CLI login.
// Layer: API identity
// Depends on: jose (JWKS + JWT verification), WorkOS User Management REST API.

import type { DeviceAuthorizationResponse } from "@synara/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ApiConfig } from "./config";

/** The subset of a WorkOS user this service surfaces (see /me). */
export type WorkosUser = {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
};

export type VerifiedAccessToken = {
  userId: string;
  sessionId: string;
};

export type WorkosAuth = {
  /** Rejects on any invalid, expired, or unverifiable token; callers answer 401. */
  verifyAccessToken(token: string): Promise<VerifiedAccessToken>;
  getUser(userId: string): Promise<WorkosUser>;
  requestDeviceAuthorization(): Promise<DeviceAuthorizationResponse>;
};

export class WorkosApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkosApiError";
  }
}

type WorkosUserResponse = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
};

/**
 * The two fields of the OIDC metadata document this service reads. WorkOS
 * serves it per client id, and it is the only authority on both values: `iss`
 * is scoped to the *environment's* client id, which differs from the app's
 * whenever the AuthKit application is not the environment default.
 */
type OidcMetadata = {
  issuer?: unknown;
  jwks_uri?: unknown;
};

function discoveryUrl(config: ApiConfig): string {
  return `${config.workosApiUrl}/user_management/${encodeURIComponent(config.workosClientId)}/.well-known/openid-configuration`;
}

type VerificationKeys = {
  issuer: string;
  jwks: JWTVerifyGetKey;
};

type WorkosDeviceAuthorizationWire = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

function fullName(user: WorkosUserResponse): string | undefined {
  const parts = [user.first_name, user.last_name].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function createWorkosAuth(config: ApiConfig): WorkosAuth {
  /**
   * Resolved on first verification and kept for the process lifetime. The
   * promise itself is what is cached, so concurrent first requests share one
   * discovery fetch instead of racing N of them; a failed attempt is dropped
   * so a transient outage does not poison the process forever.
   */
  let verificationKeys: Promise<VerificationKeys> | undefined;

  async function discoverVerificationKeys(): Promise<VerificationKeys> {
    // Nothing to discover when the operator pinned both — a stand-in or a
    // custom auth domain never has to be reachable at the metadata path.
    if (config.workosIssuer && config.workosJwksUrl) {
      return {
        issuer: config.workosIssuer,
        jwks: createRemoteJWKSet(new URL(config.workosJwksUrl)),
      };
    }

    const url = discoveryUrl(config);
    let metadata: OidcMetadata;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`responded ${response.status}`);
      }
      metadata = (await response.json()) as OidcMetadata;
    } catch (cause) {
      throw new Error(
        `Could not load WorkOS OIDC metadata from ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const issuer = config.workosIssuer ?? metadata.issuer;
    const jwksUrl = config.workosJwksUrl ?? metadata.jwks_uri;
    // Verification without a trusted issuer would accept tokens minted for any
    // other tenancy that shares a JWKS, so an unusable document is fatal
    // rather than a reason to relax the check.
    if (typeof issuer !== "string" || typeof jwksUrl !== "string") {
      throw new Error(
        `WorkOS OIDC metadata from ${url} is missing issuer or jwks_uri; set WORKOS_ISSUER and WORKOS_JWKS_URL to override`,
      );
    }
    // Built once so the key set is cached across requests rather than
    // refetched per verification; jose refreshes it on an unknown `kid`.
    return { issuer, jwks: createRemoteJWKSet(new URL(jwksUrl)) };
  }

  function resolveVerificationKeys(): Promise<VerificationKeys> {
    if (!verificationKeys) {
      const pending = discoverVerificationKeys();
      verificationKeys = pending;
      pending.catch(() => {
        if (verificationKeys === pending) verificationKeys = undefined;
      });
    }
    return verificationKeys;
  }

  async function workosFetch(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${config.workosApiUrl}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${config.workosApiKey}`,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new WorkosApiError(
        response.status,
        `WorkOS ${path} failed with ${response.status}${body ? `: ${body}` : ""}`,
      );
    }
    return response.json();
  }

  return {
    async verifyAccessToken(token) {
      const { issuer, jwks } = await resolveVerificationKeys();
      const { payload } = await jwtVerify(token, jwks, { issuer });
      const { sub, sid } = payload;
      // A WorkOS access token always carries both; anything else is not one,
      // and treating it as authenticated would lose the session identity that
      // logout and session listing depend on.
      if (typeof sub !== "string" || typeof sid !== "string") {
        throw new Error("Access token is missing the sub or sid claim");
      }
      return { userId: sub, sessionId: sid };
    },

    async getUser(userId) {
      const user = (await workosFetch(
        `/user_management/users/${encodeURIComponent(userId)}`,
      )) as WorkosUserResponse;
      const name = fullName(user);
      return {
        id: user.id,
        email: user.email,
        ...(name ? { name } : {}),
        ...(user.profile_picture_url ? { avatarUrl: user.profile_picture_url } : {}),
      };
    },

    async requestDeviceAuthorization() {
      const response = (await workosFetch("/user_management/authorize/device", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.workosClientId }).toString(),
      })) as WorkosDeviceAuthorizationWire;

      return {
        deviceCode: response.device_code,
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        verificationUriComplete: response.verification_uri_complete,
        expiresIn: response.expires_in,
        interval: response.interval,
      };
    },
  };
}

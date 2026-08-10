// FILE: identity/workos.ts
// Purpose: The WorkOS AuthKit implementation of the identity adapter seam —
// access-token verification against the JWKS, user lookup, the Magic Auth /
// email-verification / device grants, and organization membership. Everything
// WorkOS-specific lives here: wire shapes, refusal spellings, error classes.
// Nothing outside this module (and config plumbing) may name WorkOS.
// Layer: API identity (implementation)
// Depends on: jose (JWKS + JWT verification), WorkOS User Management REST API,
// interfaces.ts (the seam), orgProvisioning.ts (org resolution + cache).

import type { DeviceAuthorizationResponse } from "@synara/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { WorkosApiConfig } from "../config";
import {
  IdentityAuthError,
  IdentityProviderError,
  RefreshRejectedError,
  type AccountIdentityVerifier,
  type AuthFailureReason,
  type AuthTokens,
  type EmailVerificationChallenge,
  type EnvironmentGrantIssuer,
  type IdentityUser,
  type OrganizationRef,
} from "./interfaces";
import { ensurePersonalOrg, invalidateOrgCacheForOrganization } from "./orgProvisioning";

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

/**
 * How long the metadata fetch may take before it is abandoned. Without this a
 * connection that is accepted and then stalls leaves the memoized promise
 * pending forever, and every verification queues behind it — the cache is only
 * evicted on rejection, so a hang would never resolve itself.
 */
const DISCOVERY_TIMEOUT_MS = 10_000;

function discoveryUrl(config: WorkosApiConfig): string {
  return `${config.workosApiUrl}/user_management/${encodeURIComponent(config.workosClientId)}/.well-known/openid-configuration`;
}

type VerificationKeys = {
  issuer: string;
  jwks: JWTVerifyGetKey;
};

/**
 * A membership as the User Management API returns it. `organization_name` is
 * served alongside the id, which is the only reason listing memberships is one
 * request rather than one plus a fan-out over the Organizations API.
 */
type WorkosMembershipWire = {
  organization_id?: unknown;
  organization_name?: unknown;
};

type WorkosMembershipListWire = {
  data?: unknown;
};

type WorkosOrganizationWire = {
  id?: unknown;
  name?: unknown;
};

/**
 * How many memberships one listing request asks for. WorkOS caps the page at
 * 100 and this service does not paginate: a user in more than 100
 * organizations would see the rest omitted, which is a limit worth raising
 * only once teams exist at all.
 */
const MEMBERSHIP_PAGE_LIMIT = 100;

type WorkosDeviceAuthorizationWire = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/**
 * Reads one membership off the wire, refusing anything unusable. Skipping a
 * malformed row would be the tempting choice, but a membership list is an
 * authorization input: a partial list silently narrows what the caller can
 * see, and an empty one makes the service provision a duplicate personal
 * organization. Failing the request is the recoverable outcome; quietly
 * dropping a row is not.
 */
function toOrganization(entry: unknown): OrganizationRef {
  if (typeof entry !== "object" || entry === null) {
    throw new IdentityProviderError(
      502,
      "WorkOS returned a membership entry that is not an object",
    );
  }
  const { organization_id: orgId, organization_name: orgName } = entry as WorkosMembershipWire;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new IdentityProviderError(502, "WorkOS returned a membership with no organization id");
  }
  return {
    orgId,
    // Falls back to the id so the field is always displayable. An unnamed
    // organization is not a reason to hide it from the workspace picker.
    orgName: typeof orgName === "string" && orgName.trim().length > 0 ? orgName : orgId,
  };
}

function fullName(user: WorkosUserResponse): string | undefined {
  const parts = [user.first_name, user.last_name].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Which classified failure, if any, a Magic Auth grant refusal describes.
 *
 * WorkOS is not consistent about where the reason lives: authentication
 * errors carry a `code` while OAuth-shaped refusals carry an `error`, with
 * the HTTP status not reliably distinguishing them. Both are checked, and an
 * unrecognised body yields `undefined` so the caller reports an upstream
 * fault rather than guessing "wrong code".
 *
 * The credential this grant authenticates with is the emailed one-time code,
 * so the OAuth `invalid_grant` / `invalid_credentials` spellings mean "the
 * code was refused" here — retryable in place, unlike the expired spellings.
 */
export function classifyMagicAuthFailure(raw: unknown): AuthFailureReason | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : undefined;
  const error = typeof body.error === "string" ? body.error : undefined;

  // Defensive: Magic Auth implicitly verifies the email, so this challenge
  // should never arrive on this grant — but if WorkOS answers it anyway, the
  // existing verification machinery can complete it.
  if (code === "email_verification_required") return "email_verification_required";
  // Domain policy, not a credential outcome: the email's domain has an SSO
  // connection, so WorkOS refuses non-SSO authentication for it
  // categorically. "Use your company sign-on" is the only actionable answer,
  // and it reveals domain policy, not account existence.
  if (error === "sso_required" || code === "sso_required") return "sso_required";
  if (error === "organization_authentication_methods_required") return "sso_required";
  // A refused code that may be retried in place.
  if (code === "invalid_one_time_code" || code === "invalid_code") {
    return "invalid_verification_code";
  }
  if (error === "invalid_grant" || code === "invalid_credentials") {
    return "invalid_verification_code";
  }
  // Spent or expired; only a resend recovers.
  if (code === "one_time_code_expired" || code === "magic_auth_expired") {
    return "verification_expired";
  }
  return undefined;
}

/**
 * The verification challenge an `email_verification_required` refusal names,
 * or `undefined` when the body does not carry all three fields. Extraction is
 * allowlist-style — exactly these fields, nothing else off the body — and it
 * exists only for this one failure; every other refusal stays discard-everything.
 */
export function extractVerificationChallenge(raw: unknown): EmailVerificationChallenge | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  const pendingAuthenticationToken = body.pending_authentication_token;
  const email = body.email;
  const emailVerificationId = body.email_verification_id;
  if (
    typeof pendingAuthenticationToken !== "string" ||
    pendingAuthenticationToken.length === 0 ||
    typeof email !== "string" ||
    email.length === 0 ||
    typeof emailVerificationId !== "string" ||
    emailVerificationId.length === 0
  ) {
    return undefined;
  }
  return { pendingAuthenticationToken, email, emailVerificationId };
}

/**
 * Which classified failure a refusal of the *email-verification grant*
 * describes. Separate from {@link classifyMagicAuthFailure} because the same
 * OAuth spelling means different things per grant: `invalid_grant` on the
 * Magic Auth grant is a refused code (retryable), while on the verification
 * grant the credential being refused is the pending token — spent, expired,
 * or never ours — which only a resend or a fresh sign-in recovers.
 *
 * WorkOS does not document whether a wrong code spends the pending token, so
 * both outcomes are represented: `invalid_verification_code` (the code was
 * refused; retry in place) and `verification_expired` (the token or code is
 * dead; offer resend/start-over). An unrecognised body yields `undefined` and
 * becomes an upstream fault, as everywhere else.
 */
export function classifyVerificationFailure(raw: unknown): AuthFailureReason | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : undefined;
  const error = typeof body.error === "string" ? body.error : undefined;

  // The code itself was wrong but the attempt may be retried in place.
  if (code === "invalid_one_time_code" || code === "invalid_code") {
    return "invalid_verification_code";
  }
  if (code === "email_verification_code_incorrect") return "invalid_verification_code";
  // The code or the pending token is spent or expired; retyping cannot help.
  if (code === "email_verification_code_expired" || code === "one_time_code_expired") {
    return "verification_expired";
  }
  if (code === "pending_authentication_token_expired") return "verification_expired";
  if (error === "invalid_grant" || code === "invalid_pending_authentication_token") {
    return "verification_expired";
  }
  // WorkOS re-answers the original refusal when the token is still pending
  // but the code was not accepted — treat it as a wrong code.
  if (code === "email_verification_required") return "invalid_verification_code";
  return undefined;
}

/**
 * The token pair, read off the authenticate response. Decoded rather than
 * cast: a shape change must fail loudly here instead of persisting
 * `undefined` as somebody's access token.
 */
function toAuthTokens(raw: unknown): AuthTokens {
  if (typeof raw !== "object" || raw === null) {
    throw new IdentityProviderError(502, "WorkOS authenticate returned a non-object body");
  }
  const body = raw as Record<string, unknown>;
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new IdentityProviderError(502, "WorkOS authenticate returned no token pair");
  }
  const user = (body.user ?? {}) as WorkosUserResponse;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    throw new IdentityProviderError(502, "WorkOS authenticate returned no user");
  }
  const name = fullName(user);
  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      ...(name ? { name } : {}),
      ...(user.profile_picture_url ? { avatarUrl: user.profile_picture_url } : {}),
    },
  };
}

/**
 * The raw WorkOS organization calls, exposed alongside the seam adapters so
 * this implementation's own tests (and cross-checking assertions) can talk to
 * WorkOS directly. Not part of the seam: nothing outside identity/ may
 * depend on it.
 */
export type WorkosOrganizationsApi = {
  listUserOrganizationMemberships(userId: string): Promise<OrganizationRef[]>;
  createOrganization(name: string): Promise<OrganizationRef>;
  createOrganizationMembership(orgId: string, userId: string): Promise<void>;
};

/**
 * Both halves of the WorkOS provider — the verifier and the grant issuer —
 * built together because they share one HTTP client and one config. The
 * device-credential store and environment registry are deliberately not
 * built here: they are database-owned and provider-independent, so the
 * generic factory constructs them.
 */
export function createWorkosIdentityProvider(config: WorkosApiConfig): {
  verifier: AccountIdentityVerifier;
  grants: EnvironmentGrantIssuer;
  organizations: WorkosOrganizationsApi;
} {
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
      const response = await fetch(url, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
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
      throw new IdentityProviderError(
        response.status,
        `WorkOS ${path} failed with ${response.status}${body ? `: ${body}` : ""}`,
      );
    }
    return response.json();
  }

  /**
   * A WorkOS call whose request or response contains a credential (the
   * emailed one-time code, or the pending authentication token).
   *
   * Deliberately not `workosFetch`: that helper puts the upstream response
   * body into the thrown error's message, and WorkOS echoes offending fields
   * in validation errors — so a mistyped code could end up in an error
   * string, and from there in a log. Nothing thrown from here carries any part
   * of the request or the response.
   *
   * Returns the parsed body on success; throws {@link IdentityAuthError} for
   * a classified refusal and a bare {@link IdentityProviderError} otherwise.
   */
  async function sensitiveFetch(
    path: string,
    body: Record<string, string>,
    // Each grant brings its own classifier: the same OAuth spellings mean
    // different things per grant, but the no-leak handling of the request
    // and response is identical.
    classify: (raw: unknown) => AuthFailureReason | undefined,
  ): Promise<unknown> {
    const response = await fetch(`${config.workosApiUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.workosApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) return response.json();

    // Read the failure only to classify it. The parsed value is never
    // returned or attached to an error — except the verification challenge,
    // whose three fields are extracted allowlist-style below because they are
    // exactly what completing verification in-app redeems.
    const raw = await response.json().catch(() => null);
    const failure = classify(raw);
    if (failure === "email_verification_required") {
      throw new IdentityAuthError(failure, extractVerificationChallenge(raw));
    }
    if (failure) throw new IdentityAuthError(failure);
    // An unclassified refusal becomes an opaque 502 to the caller, so this
    // line is the only place its identity survives. Log the status and the
    // two code fields ONLY — both are WorkOS-chosen enum spellings. Never the
    // description or the body: those echo request fields, and this is a
    // credential route.
    const refusal = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    console.error(
      `[api] unclassified WorkOS auth failure: status=${response.status}` +
        ` code=${typeof refusal.code === "string" ? refusal.code : "-"}` +
        ` error=${typeof refusal.error === "string" ? refusal.error : "-"}`,
    );
    throw new IdentityProviderError(
      response.status,
      `WorkOS ${path} failed with ${response.status}`,
    );
  }

  async function listUserOrganizationMemberships(userId: string): Promise<OrganizationRef[]> {
    const response = (await workosFetch(
      `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&limit=${MEMBERSHIP_PAGE_LIMIT}`,
    )) as WorkosMembershipListWire;
    // A 200 without a `data` array is not an empty membership list, it is an
    // answer this service does not understand — and reading it as "no
    // organizations" would both hide the caller's hosts and provision them a
    // second personal workspace.
    if (!Array.isArray(response.data)) {
      throw new IdentityProviderError(502, "WorkOS membership listing returned no data array");
    }
    return response.data.map(toOrganization);
  }

  // Organizations live on the top-level Organizations API, not under
  // /user_management — the one endpoint here that breaks that pattern.
  async function createOrganization(name: string): Promise<OrganizationRef> {
    const response = (await workosFetch("/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })) as WorkosOrganizationWire;
    if (typeof response.id !== "string" || response.id.length === 0) {
      throw new Error("WorkOS organization creation returned no id");
    }
    return {
      orgId: response.id,
      orgName: typeof response.name === "string" && response.name ? response.name : name,
    };
  }

  async function createOrganizationMembership(orgId: string, userId: string): Promise<void> {
    await workosFetch("/user_management/organization_memberships", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization_id: orgId, user_id: userId }),
    });
  }

  const verifier: AccountIdentityVerifier = {
    async verifyAccessToken(token) {
      const { issuer, jwks } = await resolveVerificationKeys();
      const { payload } = await jwtVerify(token, jwks, { issuer });
      const { sub, sid, org_id: orgId, client_id: clientId } = payload;
      // One WorkOS environment serves one issuer across every AuthKit
      // application in it, all sharing a JWKS — so signature, expiry and
      // issuer all pass for a token minted for a *sibling* application.
      // `client_id` is the only claim that says the token was meant for us.
      // Absence is refused as firmly as a mismatch: a token that cannot be
      // shown to belong to this application is not one to authorize against.
      if (clientId !== config.workosClientId) {
        throw new Error("Access token was not issued for this application");
      }
      // A WorkOS access token always carries both; anything else is not one,
      // and treating it as authenticated would lose the session identity that
      // logout and session listing depend on.
      if (typeof sub !== "string" || typeof sid !== "string") {
        throw new Error("Access token is missing the sub or sid claim");
      }
      // `org_id` is genuinely optional — a device-grant token has none — so its
      // absence is a routing fact for the caller, not a verification failure.
      return { userId: sub, sessionId: sid, ...(typeof orgId === "string" ? { orgId } : {}) };
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
      } satisfies IdentityUser;
    },

    async pollDeviceToken({ deviceCode }) {
      // The device code is bearer-ish, so this rides sensitiveFetch's no-leak
      // handling — but the flow-state refusals are expected answers of a
      // healthy poll, not failures, so they are read off the raw response
      // here instead of being pushed through a failure classifier.
      const response = await fetch(`${config.workosApiUrl}/user_management/authenticate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.workosApiKey}`,
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: config.workosClientId,
          // Confidential-client here too: proxying this leg is what keeps
          // the whole provider protocol off the client wire.
          client_secret: config.workosApiKey,
        }),
      });
      if (response.ok) {
        return { status: "granted", tokens: toAuthTokens(await response.json()) };
      }

      const raw: unknown = await response.json().catch(() => null);
      const error =
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { error?: unknown }).error === "string"
          ? (raw as { error: string }).error
          : undefined;
      // RFC 8628's four poll answers, mapped one-to-one so the client's loop
      // semantics survive the proxy hop unchanged.
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down" };
      if (error === "expired_token") return { status: "expired" };
      if (error === "access_denied") return { status: "denied" };
      // `invalid_grant` here is an unknown or spent device code — dead for
      // the same reasons an expired one is, and the client's recovery (start
      // over) is identical.
      if (error === "invalid_grant") return { status: "expired" };
      // No body or description in the message: an unrecognised refusal on a
      // credential route stays opaque, as everywhere else.
      console.error(
        `[api] unclassified WorkOS device-token failure: status=${response.status}` +
          ` error=${error ?? "-"}`,
      );
      throw new IdentityProviderError(
        response.status,
        `WorkOS device-token poll failed with ${response.status}`,
      );
    },

    async refreshTokens({ refreshToken, organizationId }) {
      const response = await fetch(`${config.workosApiUrl}/user_management/authenticate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.workosApiKey}`,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.workosClientId,
          client_secret: config.workosApiKey,
          ...(organizationId ? { organization_id: organizationId } : {}),
        }),
      });
      if (response.ok) {
        const raw: unknown = await response.json();
        const tokens = toAuthTokens(raw);
        const echoed = (raw as Record<string, unknown>).organization_id;
        return {
          ...tokens,
          ...(typeof echoed === "string" && echoed.length > 0 ? { organizationId: echoed } : {}),
        };
      }

      // A terminal 4xx is the provider refusing the token — spent, revoked,
      // or naming a lost workspace. Anything else says nothing about it, and
      // the caller must not burn a stored session over a transient fault.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new RefreshRejectedError();
      }
      // The refresh token is a credential: no body, no description.
      console.error(`[api] WorkOS refresh grant failed upstream: status=${response.status}`);
      throw new IdentityProviderError(
        response.status,
        `WorkOS refresh grant failed with ${response.status}`,
      );
    },

    async createOtpChallenge({ email }) {
      // The response contains the 6-digit code WorkOS just emailed — a
      // credential. It is parsed allowlist-style right here: only the address
      // echo and expiry ever leave this function, and the raw body is never
      // logged, thrown, or returned.
      const raw = await sensitiveFetch(
        "/user_management/magic_auth",
        { email },
        classifyMagicAuthFailure,
      );
      if (typeof raw !== "object" || raw === null) {
        throw new IdentityProviderError(502, "WorkOS magic auth returned a non-object body");
      }
      const body = raw as Record<string, unknown>;
      if (typeof body.email !== "string" || body.email.length === 0) {
        throw new IdentityProviderError(502, "WorkOS magic auth named no email");
      }
      if (typeof body.expires_at !== "string" || body.expires_at.length === 0) {
        throw new IdentityProviderError(502, "WorkOS magic auth named no expiry");
      }
      return { email: body.email, expiresAt: body.expires_at };
    },

    async authenticateWithOtp({ email, code }) {
      const raw = await sensitiveFetch(
        "/user_management/authenticate",
        {
          grant_type: "urn:workos:oauth:grant-type:magic-auth:code",
          code,
          email,
          client_id: config.workosClientId,
          // Confidential-client: WorkOS requires the secret, which is why
          // this call runs here rather than in the app.
          client_secret: config.workosApiKey,
        },
        classifyMagicAuthFailure,
      );
      return toAuthTokens(raw);
    },

    async verifyEmailCode({ code, pendingAuthenticationToken }) {
      const raw = await sensitiveFetch(
        "/user_management/authenticate",
        {
          grant_type: "urn:workos:oauth:grant-type:email-verification:code",
          code,
          pending_authentication_token: pendingAuthenticationToken,
          client_id: config.workosClientId,
          // Confidential-client, like the Magic Auth grant: WorkOS requires
          // the secret, which is why this call runs here rather than in the
          // app.
          client_secret: config.workosApiKey,
        },
        classifyVerificationFailure,
      );
      return toAuthTokens(raw);
    },

    async resendVerificationEmail(emailVerificationId) {
      // The caller holds only the verification id; the user id it belongs to
      // is read from the verification object here, server-side. Chosen over a
      // user-by-email lookup because the id names exactly one verification —
      // an email search could match a user the id was never issued for.
      const verification = (await workosFetch(
        `/user_management/email_verification/${encodeURIComponent(emailVerificationId)}`,
      )) as { user_id?: unknown };
      if (typeof verification.user_id !== "string" || verification.user_id.length === 0) {
        throw new IdentityProviderError(502, "WorkOS email verification object named no user id");
      }
      await workosFetch(
        `/user_management/users/${encodeURIComponent(verification.user_id)}/email_verification/send`,
        { method: "POST" },
      );
    },

    async requestDeviceAuthorization() {
      const response = (await workosFetch("/user_management/authorize/device", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.workosClientId }).toString(),
      })) as WorkosDeviceAuthorizationWire;

      const mapped: DeviceAuthorizationResponse = {
        deviceCode: response.device_code,
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        verificationUriComplete: response.verification_uri_complete,
        expiresIn: response.expires_in,
        interval: response.interval,
      };
      return mapped;
    },

    describeInstanceAuth() {
      // The device-flow poll and token refresh go from the client straight to
      // WorkOS, which is why the client id and API origin are published.
      return {
        authMode: "workos",
        clientId: config.workosClientId,
        workosApiUrl: config.workosApiUrl,
      };
    },
  };

  const grants: EnvironmentGrantIssuer = {
    async resolveEnvironmentScope(session, email) {
      const memberships = await ensurePersonalOrg(
        { listUserOrganizationMemberships, createOrganization, createOrganizationMembership },
        session.userId,
        email,
      );
      if (!session.orgId) {
        return { kind: "selection_required", why: "unscoped", organizations: memberships };
      }
      const active = memberships.find((membership) => membership.orgId === session.orgId);
      if (!active) {
        return { kind: "selection_required", why: "not_a_member", organizations: memberships };
      }
      return { kind: "scoped", organization: active };
    },

    async renameOrganization(orgId, name) {
      // WorkOS models the rename as a full replacement (PUT).
      const response = (await workosFetch(`/organizations/${encodeURIComponent(orgId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      })) as WorkosOrganizationWire;
      if (typeof response.id !== "string" || response.id.length === 0) {
        throw new IdentityProviderError(502, "WorkOS organization update returned no id");
      }
      // Membership lists carry the organization name, so they are stale the
      // moment the rename lands — including the one this request populated.
      invalidateOrgCacheForOrganization(orgId);
      return {
        orgId: response.id,
        orgName: typeof response.name === "string" && response.name ? response.name : name,
      };
    },
  };

  return {
    verifier,
    grants,
    organizations: {
      listUserOrganizationMemberships,
      createOrganization,
      createOrganizationMembership,
    },
  };
}

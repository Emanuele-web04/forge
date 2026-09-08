// FILE: identity/workos.ts
// Purpose: The WorkOS AuthKit implementation of the identity adapter seam —
// access-token verification against the JWKS, user lookup, the Magic Auth
// and PKCE grants, and organization membership. Everything
// WorkOS-specific lives here: wire shapes, refusal spellings, error classes.
// Nothing outside this module (and config plumbing) may name WorkOS.
// Layer: API identity (implementation)
// Depends on: jose (JWKS + JWT verification), WorkOS User Management REST API,
// interfaces.ts (the seam), orgProvisioning.ts (org resolution + cache).

import type { AccountSsoProvider } from "@synara/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { WorkosApiConfig } from "../config";
import {
  IdentityAuthError,
  IdentityProviderError,
  RefreshRejectedError,
  type AccountIdentityVerifier,
  type AuthFailureReason,
  type AuthRequestContext,
  type AuthTokens,
  type EnvironmentGrantIssuer,
  type IdentityUser,
  type OrganizationRef,
} from "./interfaces";
import {
  ensurePersonalOrg,
  invalidateOrgCacheForOrganization,
  listUserOrganizations,
} from "./orgProvisioning";

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

/**
 * Per-attempt deadline on cheap, idempotent WorkOS calls — discovery, `/me`,
 * user and organization lookups. A connection that is accepted and then
 * stalls would otherwise pin the Hono request (and any WebSocket RPC behind
 * it) forever. Timeouts surface as a 504 IdentityProviderError — a provider
 * fault, retryable, never a refusal of whatever credential the call carried.
 */
export const WORKOS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Per-attempt deadline on the GRANT-consuming calls: the Magic Auth
 * authenticate, the refresh grant, and the PKCE code exchange. Deliberately
 * much longer than
 * {@link WORKOS_REQUEST_TIMEOUT_MS}: these calls spend a single-use
 * credential, so aborting one that the provider goes on to complete leaves
 * the user with a consumed code and an error for a sign-in that actually
 * succeeded — a slow provider must not cause us to abandon a credential we
 * may already have spent. A cheap lookup can afford to fail fast; a grant
 * cannot.
 */
export const WORKOS_GRANT_TIMEOUT_MS = 45_000;

function isAbortTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

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
  list_metadata?: unknown;
};

type WorkosOrganizationWire = {
  id?: unknown;
  name?: unknown;
};

/** How many memberships one listing request asks for. WorkOS caps it at 100. */
const MEMBERSHIP_PAGE_LIMIT = 100;

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

/**
 * The WorkOS `ip_address`/`user_agent` fields for an authenticate call, from
 * the sanitized request context. Forwarded so WorkOS's own risk controls see
 * the caller, not this proxy; absent fields are simply omitted.
 */
function contextFields(context: AuthRequestContext | undefined): Record<string, string> {
  return {
    ...(context?.ipAddress ? { ip_address: context.ipAddress } : {}),
    ...(context?.userAgent ? { user_agent: context.userAgent } : {}),
  };
}

/**
 * The WorkOS error spellings this service knows about, for logging ONLY.
 * The `code`/`error` fields of a refusal are free-form provider strings, and
 * on a credential route a hostile or buggy upstream could put a submitted
 * secret in them — so an unclassified refusal's log line carries an internal
 * label from this allowlist, never the raw field. Classification for
 * behavior lives in the classifiers above; this list exists so an operator
 * can still tell refusal families apart in production without any provider
 * string reaching a log.
 */
const LOGGABLE_REFUSAL_SPELLINGS: ReadonlySet<string> = new Set([
  "email_verification_required",
  "sso_required",
  "organization_authentication_methods_required",
  "organization_selection_required",
  "invalid_one_time_code",
  "invalid_code",
  "invalid_credentials",
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unsupported_grant_type",
  "one_time_code_expired",
  "magic_auth_expired",
  "email_verification_code_incorrect",
  "email_verification_code_expired",
  "pending_authentication_token_expired",
  "invalid_pending_authentication_token",
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
]);

/** An allowlisted label for a provider field value: the value itself only when recognized. */
function loggableRefusalLabel(value: unknown): string {
  if (typeof value !== "string") return "-";
  return LOGGABLE_REFUSAL_SPELLINGS.has(value) ? value : "unrecognized";
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
  // should never arrive on this grant — if WorkOS answers it anyway it is
  // classified and surfaced as a terse dead-end.
  if (code === "email_verification_required") return "email_verification_required";
  // Domain policy, not a credential outcome: the email's domain has an SSO
  // connection, so WorkOS refuses non-SSO authentication for it
  // categorically. "Use your company sign-on" is the only actionable answer,
  // and it reveals domain policy, not account existence.
  if (error === "sso_required" || code === "sso_required") return "sso_required";
  if (error === "organization_authentication_methods_required") return "sso_required";
  // The caller belongs to several organizations and WorkOS wants a choice
  // made. V1 fails closed on this rather than picking one or 502ing.
  if (error === "organization_selection_required" || code === "organization_selection_required") {
    return "organization_selection_required";
  }
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
 * Synara's provider vocabulary → WorkOS's `provider` parameter on
 * `GET /user_management/authorize`. The only place the WorkOS spellings
 * exist; the wire and the seam speak Synara's own names.
 */
const WORKOS_AUTHORIZE_PROVIDERS: Record<AccountSsoProvider, string> = {
  google: "GoogleOAuth",
  apple: "AppleOAuth",
  github: "GitHubOAuth",
};

/**
 * Which classified failure a refusal of the *authorization-code grant*
 * describes. The credential here is the authorization code (bound to the
 * PKCE verifier): `invalid_grant` means it is spent, expired, or never ours,
 * and only starting the sign-in over recovers — the same recovery as an
 * expired emailed code, so it shares that classification. The multi-org and
 * verification refusals keep their usual meanings.
 */
export function classifyAuthorizationCodeFailure(raw: unknown): AuthFailureReason | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : undefined;
  const error = typeof body.error === "string" ? body.error : undefined;

  if (code === "email_verification_required") return "email_verification_required";
  if (error === "organization_selection_required" || code === "organization_selection_required") {
    return "organization_selection_required";
  }
  // A spent, expired, or foreign code — or a failed PKCE proof. Dead either
  // way; only a fresh authorization recovers.
  if (error === "invalid_grant" || code === "invalid_grant") return "verification_expired";
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

  const requestTimeoutMs = config.workosRequestTimeoutMs ?? WORKOS_REQUEST_TIMEOUT_MS;
  const grantTimeoutMs = config.workosGrantTimeoutMs ?? WORKOS_GRANT_TIMEOUT_MS;

  /**
   * `fetch` with a per-attempt deadline. A connection that is accepted and
   * then stalls must fail this one call, not pin the request behind it
   * forever. On timeout, throws a 504 {@link IdentityProviderError} — a
   * provider fault, retryable, never a refusal of whatever credential the
   * call carried — whose message names only the path, since request fields
   * on credential paths include the secret. `timeoutMs` defaults to the
   * cheap-call deadline; grant-consuming calls pass the longer grant one.
   */
  async function fetchWithDeadline(
    url: string,
    path: string,
    init: RequestInit,
    timeoutMs: number = requestTimeoutMs,
  ): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isAbortTimeout(error)) {
        throw new IdentityProviderError(504, `WorkOS ${path} timed out`);
      }
      throw error;
    }
  }

  async function workosFetch(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchWithDeadline(`${config.workosApiUrl}${path}`, path, {
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
    // Grant-consuming calls pass the longer grant deadline; a call that only
    // mints a challenge keeps the cheap-call default.
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await fetchWithDeadline(
      `${config.workosApiUrl}${path}`,
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.workosApiKey}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (response.ok) return response.json();

    // Read the failure only to classify it. The parsed value is never
    // returned or attached to an error.
    const raw = await response.json().catch(() => null);
    const failure = classify(raw);
    if (failure) throw new IdentityAuthError(failure);
    // An unclassified refusal becomes an opaque 502 to the caller, so this
    // line is the only place its identity survives. Log the status plus
    // allowlisted labels ONLY: the code fields are free-form provider
    // strings, and on a credential route an unexpected upstream could echo
    // the submitted secret into them — so anything not on the known-spelling
    // list logs as "unrecognized", never verbatim.
    const refusal = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    console.error(
      `[api] unclassified WorkOS auth failure: status=${response.status}` +
        ` code=${loggableRefusalLabel(refusal.code)}` +
        ` error=${loggableRefusalLabel(refusal.error)}`,
    );
    throw new IdentityProviderError(
      response.status,
      `WorkOS ${path} failed with ${response.status}`,
    );
  }

  async function listUserOrganizationMemberships(userId: string): Promise<OrganizationRef[]> {
    const memberships: OrganizationRef[] = [];
    let after: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = (await workosFetch(
        `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&limit=${MEMBERSHIP_PAGE_LIMIT}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      )) as WorkosMembershipListWire;
      // A 200 without a `data` array is not an empty membership list, it is an
      // answer this service does not understand — and reading it as "no
      // organizations" would both hide the caller's hosts and provision them
      // a second personal workspace.
      if (!Array.isArray(response.data)) {
        throw new IdentityProviderError(502, "WorkOS membership listing returned no data array");
      }
      memberships.push(...response.data.map(toOrganization));
      const metadata = response.list_metadata;
      if (typeof metadata !== "object" || metadata === null) {
        throw new IdentityProviderError(502, "WorkOS membership listing returned no metadata");
      }
      const next = (metadata as { after?: unknown }).after;
      if (next !== null && next !== undefined && typeof next !== "string") {
        throw new IdentityProviderError(502, "WorkOS membership listing returned a bad cursor");
      }
      after = typeof next === "string" && next.length > 0 ? next : undefined;
      if (after && seenCursors.has(after)) {
        throw new IdentityProviderError(502, "WorkOS membership listing repeated a cursor");
      }
      if (after) seenCursors.add(after);
    } while (after);
    return memberships;
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

    async refreshTokens({ refreshToken, organizationId, context }) {
      const response = await fetchWithDeadline(
        `${config.workosApiUrl}/user_management/authenticate`,
        "/user_management/authenticate",
        {
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
            ...contextFields(context),
          }),
        },
        // Grant-consuming: refresh tokens are single-use, and an abort after
        // the provider rotated the pair strands the stored session.
        grantTimeoutMs,
      );
      if (response.ok) {
        const raw: unknown = await response.json();
        const tokens = toAuthTokens(raw);
        const echoed = (raw as Record<string, unknown>).organization_id;
        return {
          ...tokens,
          ...(typeof echoed === "string" && echoed.length > 0 ? { organizationId: echoed } : {}),
        };
      }

      // Only the OAuth refusal proves the token is dead: HTTP 400 carrying
      // `invalid_grant` (spent, revoked, or naming a lost workspace) — the
      // allowlisted terminal case. Everything else — 408, 429, other 4xx
      // shapes, 5xx — says nothing about the token, and the caller must not
      // burn a stored session over a transient fault. The body is read only
      // for that one enum field and never logged: the refresh token is a
      // credential and provider descriptions echo request fields.
      if (response.status === 400) {
        const raw: unknown = await response.json().catch(() => null);
        const oauthError =
          typeof raw === "object" &&
          raw !== null &&
          typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : undefined;
        if (oauthError === "invalid_grant") {
          throw new RefreshRejectedError();
        }
      }
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

    async authenticateWithOtp({ email, code, context }) {
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
          ...contextFields(context),
        },
        classifyMagicAuthFailure,
        // Grant-consuming: the emailed code is single-use.
        grantTimeoutMs,
      );
      return toAuthTokens(raw);
    },

    buildAuthorizeUrl({ provider, redirectUri, codeChallenge, state }) {
      // The hosted authorize endpoint, deep-linked to the chosen provider.
      // PKCE (S256) because the requesting client is public — the verifier
      // never appears here, only its one-way challenge.
      const params = new URLSearchParams({
        client_id: config.workosClientId,
        redirect_uri: redirectUri,
        response_type: "code",
        provider: WORKOS_AUTHORIZE_PROVIDERS[provider],
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      });
      return `${config.workosApiUrl}/user_management/authorize?${params.toString()}`;
    },

    async exchangeAuthorizationCode({ code, codeVerifier, context }) {
      const raw = await sensitiveFetch(
        "/user_management/authenticate",
        {
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: config.workosClientId,
          // Proxied like every other grant so the vendor stays off the client
          // wire; the PKCE verifier is the proof of possession, the secret
          // authenticates this service.
          client_secret: config.workosApiKey,
          ...contextFields(context),
        },
        classifyAuthorizationCodeFailure,
        // Grant-consuming: the authorization code is single-use.
        grantTimeoutMs,
      );
      return toAuthTokens(raw);
    },

    describeInstanceAuth() {
      // Deprecated-but-present: every provider call is proxied now, and
      // Synara's own clients ignore these — only clients from before the
      // proxy cutover still poll WorkOS directly with them.
      return {
        authMode: "workos",
        clientId: config.workosClientId,
        workosApiUrl: config.workosApiUrl,
      };
    },
  };

  const grants: EnvironmentGrantIssuer = {
    async resolveEnvironmentScope(session, email, options) {
      const memberships = await ensurePersonalOrg(
        { listUserOrganizationMemberships, createOrganization, createOrganizationMembership },
        session.userId,
        email,
        options?.freshMembership ? { fresh: true } : undefined,
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

    async countOrganizationMembers(orgId, atLeast) {
      // The membership listing filtered by organization; asking for exactly
      // `atLeast` rows answers "single-member or not" in one bounded request
      // without paginating a large team.
      const response = (await workosFetch(
        `/user_management/organization_memberships?organization_id=${encodeURIComponent(orgId)}&limit=${Math.max(1, atLeast)}`,
      )) as WorkosMembershipListWire;
      if (!Array.isArray(response.data)) {
        throw new IdentityProviderError(
          502,
          "WorkOS organization membership listing returned no data array",
        );
      }
      return response.data.length;
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

    listUserOrganizations(userId, options) {
      return listUserOrganizations(
        { listUserOrganizationMemberships, createOrganization, createOrganizationMembership },
        userId,
        options?.freshMembership ? { fresh: true } : undefined,
      );
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

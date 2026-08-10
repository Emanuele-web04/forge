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
  /**
   * The organization the token is scoped to, when it has one. Absent on every
   * token the device grant mints — WorkOS only puts `org_id` in a token
   * obtained by authenticating *into* an organization, which for this service
   * means the refresh grant carrying an `organization_id`.
   */
  orgId?: string;
};

/** A WorkOS organization the caller belongs to. */
export type WorkosOrganization = {
  orgId: string;
  orgName: string;
};

/**
 * Why a password failed, as this service classifies it. WorkOS reports these
 * inconsistently — some as an OAuth `error`, some as a `code`, with the HTTP
 * status not reliably distinguishing them — so the classification happens once
 * here rather than at each call site.
 */
export type WorkosPasswordFailure =
  | "invalid_credentials"
  | "email_taken"
  | "email_verification_required";

/**
 * A password grant this service refused to complete. Carries the classified
 * reason and nothing else: notably not the password, and not WorkOS's raw
 * message, which can echo the submitted credentials back.
 */
export class WorkosPasswordError extends Error {
  constructor(readonly reason: WorkosPasswordFailure) {
    super(reason);
    this.name = "WorkosPasswordError";
  }
}

/** The token pair a successful password grant yields. */
export type WorkosPasswordAuth = {
  accessToken: string;
  refreshToken: string;
  user: WorkosUser;
};

export type WorkosAuth = {
  /** Rejects on any invalid, expired, or unverifiable token; callers answer 401. */
  verifyAccessToken(token: string): Promise<VerifiedAccessToken>;
  getUser(userId: string): Promise<WorkosUser>;
  requestDeviceAuthorization(): Promise<DeviceAuthorizationResponse>;
  /**
   * The password grant. Requires the client secret, which is the whole reason
   * this runs here rather than in the app: a public client cannot hold it.
   * Rejects with {@link WorkosPasswordError} on a classified refusal.
   */
  authenticateWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<WorkosPasswordAuth>;
  /** Creates a user, then authenticates them. Same rejection contract. */
  createUserWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<WorkosPasswordAuth>;
  /** Every organization the user is a member of, oldest page first. */
  listUserOrganizationMemberships(userId: string): Promise<WorkosOrganization[]>;
  createOrganization(name: string): Promise<WorkosOrganization>;
  /** Renames an organization. Callers must have checked membership first. */
  updateOrganization(orgId: string, name: string): Promise<WorkosOrganization>;
  createOrganizationMembership(orgId: string, userId: string): Promise<void>;
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

/**
 * How long the metadata fetch may take before it is abandoned. Without this a
 * connection that is accepted and then stalls leaves the memoized promise
 * pending forever, and every verification queues behind it — the cache is only
 * evicted on rejection, so a hang would never resolve itself.
 */
const DISCOVERY_TIMEOUT_MS = 10_000;

function discoveryUrl(config: ApiConfig): string {
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
function toOrganization(entry: unknown): WorkosOrganization {
  if (typeof entry !== "object" || entry === null) {
    throw new WorkosApiError(502, "WorkOS returned a membership entry that is not an object");
  }
  const { organization_id: orgId, organization_name: orgName } = entry as WorkosMembershipWire;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new WorkosApiError(502, "WorkOS returned a membership with no organization id");
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
 * Which classified failure, if any, a WorkOS error body describes.
 *
 * WorkOS is not consistent about where the reason lives: authentication errors
 * carry a `code`, OAuth-shaped refusals carry an `error`, and validation
 * failures carry neither at the top level but name the offending field. All
 * three are checked, and an unrecognised body yields `undefined` so the caller
 * reports an upstream fault rather than guessing "wrong password".
 *
 * The values matched here are drawn from WorkOS's documented authentication
 * error codes; the `invalid_grant` fallback covers the OAuth-shaped refusal
 * the password grant returns for a bad email/password pair.
 */
export function classifyPasswordFailure(raw: unknown): WorkosPasswordFailure | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : undefined;
  const error = typeof body.error === "string" ? body.error : undefined;

  if (code === "email_verification_required") return "email_verification_required";
  // WorkOS spells the duplicate-email refusal differently across endpoints;
  // both observed spellings mean the same thing to a user signing up.
  if (code === "email_not_available" || code === "user_creation_error") return "email_taken";
  if (code === "entity_already_exists") return "email_taken";
  if (error === "invalid_grant" || code === "invalid_credentials") return "invalid_credentials";
  // An unknown email must answer as a plain wrong-password would. Before this
  // case existed it fell through to the 502 upstream-fault path (observed live
  // against production WorkOS), which split the responses and turned the route
  // into an account-existence oracle. WorkOS does not document the refusal's
  // exact spelling, so both field positions are accepted.
  if (code === "user_not_found" || error === "user_not_found") return "invalid_credentials";

  // Validation errors name the field rather than the problem. An `email` error
  // on a create is a taken address in every case this service can produce,
  // since the address itself was already format-checked at the route.
  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (typeof entry !== "object" || entry === null) continue;
      const field = (entry as Record<string, unknown>).field;
      const rule = (entry as Record<string, unknown>).code;
      if (field === "email" && rule === "email_not_available") return "email_taken";
    }
  }
  return undefined;
}

/**
 * The token pair, read off the authenticate response. Decoded rather than
 * cast: a shape change must fail loudly here instead of persisting
 * `undefined` as somebody's access token.
 */
function toPasswordAuth(raw: unknown): WorkosPasswordAuth {
  if (typeof raw !== "object" || raw === null) {
    throw new WorkosApiError(502, "WorkOS authenticate returned a non-object body");
  }
  const body = raw as Record<string, unknown>;
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new WorkosApiError(502, "WorkOS authenticate returned no token pair");
  }
  const user = (body.user ?? {}) as WorkosUserResponse;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    throw new WorkosApiError(502, "WorkOS authenticate returned no user");
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
      throw new WorkosApiError(
        response.status,
        `WorkOS ${path} failed with ${response.status}${body ? `: ${body}` : ""}`,
      );
    }
    return response.json();
  }

  /**
   * A WorkOS call whose request body contains a password.
   *
   * Deliberately not `workosFetch`: that helper puts the upstream response
   * body into the thrown error's message, and WorkOS echoes offending fields
   * in validation errors — so a mistyped password could end up in an error
   * string, and from there in a log. Nothing thrown from here carries any part
   * of the request or the response.
   *
   * Returns the parsed body on success; throws {@link WorkosPasswordError} for
   * a classified refusal and a bare {@link WorkosApiError} otherwise.
   */
  async function passwordFetch(path: string, body: Record<string, string>): Promise<unknown> {
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
    // returned, logged, or attached to an error.
    const failure = classifyPasswordFailure(await response.json().catch(() => null));
    if (failure) throw new WorkosPasswordError(failure);
    throw new WorkosApiError(response.status, `WorkOS ${path} failed with ${response.status}`);
  }

  async function passwordGrant(body: Record<string, string>): Promise<WorkosPasswordAuth> {
    const raw = await passwordFetch("/user_management/authenticate", {
      ...body,
      client_id: config.workosClientId,
      // The password grant is a confidential-client grant: WorkOS requires the
      // secret, which is precisely why the app cannot make this call itself
      // and this service proxies it.
      client_secret: config.workosApiKey,
    });
    return toPasswordAuth(raw);
  }

  return {
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
      };
    },

    async listUserOrganizationMemberships(userId) {
      const response = (await workosFetch(
        `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&limit=${MEMBERSHIP_PAGE_LIMIT}`,
      )) as WorkosMembershipListWire;
      // A 200 without a `data` array is not an empty membership list, it is an
      // answer this service does not understand — and reading it as "no
      // organizations" would both hide the caller's hosts and provision them a
      // second personal workspace.
      if (!Array.isArray(response.data)) {
        throw new WorkosApiError(502, "WorkOS membership listing returned no data array");
      }
      return response.data.map(toOrganization);
    },

    // Organizations live on the top-level Organizations API, not under
    // /user_management — the one endpoint here that breaks that pattern.
    async createOrganization(name) {
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
    },

    async updateOrganization(orgId, name) {
      const response = (await workosFetch(`/organizations/${encodeURIComponent(orgId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      })) as WorkosOrganizationWire;
      if (typeof response.id !== "string" || response.id.length === 0) {
        throw new WorkosApiError(502, "WorkOS organization update returned no id");
      }
      return {
        orgId: response.id,
        orgName: typeof response.name === "string" && response.name ? response.name : name,
      };
    },

    async createOrganizationMembership(orgId, userId) {
      await workosFetch("/user_management/organization_memberships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: orgId, user_id: userId }),
      });
    },

    async authenticateWithPassword({ email, password }) {
      return passwordGrant({ grant_type: "password", email, password });
    },

    async createUserWithPassword({ email, password }) {
      // Create, then authenticate. Two calls because WorkOS's create-user
      // endpoint returns a user, not a session — and a session is what the
      // caller needs. A user created here who then cannot authenticate (an
      // environment that demands email verification) is left in place
      // deliberately: the account is real, and deleting it would throw away a
      // sign-up the user completed.
      await passwordFetch("/user_management/users", { email, password });
      return passwordGrant({ grant_type: "password", email, password });
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

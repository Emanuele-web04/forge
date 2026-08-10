import { Schema } from "effect";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas";

export const AccountHostTransport = Schema.Literals(["lan", "tailscale", "public"]);
export type AccountHostTransport = typeof AccountHostTransport.Type;

export const AccountHostEndpoint = Schema.Struct({
  url: TrimmedNonEmptyString,
  transport: AccountHostTransport,
});
export type AccountHostEndpoint = typeof AccountHostEndpoint.Type;

export const AccountHostPlatform = Schema.Literals(["darwin", "linux", "windows"]);
export type AccountHostPlatform = typeof AccountHostPlatform.Type;

export const AccountHostKind = Schema.Literals(["local", "ssh-managed"]);
export type AccountHostKind = typeof AccountHostKind.Type;

/**
 * A WorkOS organization as this API surfaces it. Organizations are the unit of
 * host ownership: every user has at least a personal one, and a team is the
 * same thing with more members.
 */
export const OrganizationSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type OrganizationSummary = typeof OrganizationSummary.Type;

export const AccountHost = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  platform: AccountHostPlatform,
  kind: AccountHostKind,
  endpoints: Schema.Array(AccountHostEndpoint),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  /** WorkOS user id of whoever ran the registration. Audit only — the
   * organization owns the host, so this grants no access of its own. */
  registeredByUserId: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
  lastSeenAt: TrimmedNonEmptyString,
});
export type AccountHost = typeof AccountHost.Type;

/**
 * The handle a profile is known by. Lowercase so it reads the same everywhere
 * it is shown and compares the same everywhere it is stored, and bounded at
 * both ends by the pattern: it must start on an alphanumeric and may not end
 * on a hyphen, which is what keeps `-`, `a-`, and `--` out.
 */
export const AccountProfileHandle = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/),
);
export type AccountProfileHandle = typeof AccountProfileHandle.Type;

/**
 * An avatar accent, as the web app's `PROFILE_AVATAR_COLORS` palette writes
 * them. Checked as a hex triplet rather than against the palette itself: the
 * palette is a web-side design decision that will change without a deploy of
 * the account service, and a server that rejected tomorrow's swatch would be
 * the thing standing between a user and their own profile.
 */
export const AccountProfileAvatarColor = Schema.String.check(
  Schema.isPattern(/^#[0-9a-fA-F]{6}$/),
);
export type AccountProfileAvatarColor = typeof AccountProfileAvatarColor.Type;

/**
 * The part of a user's identity Synara owns, as opposed to what WorkOS knows.
 * Its existence is what "onboarding is finished" means — there is no separate
 * flag, so a profile row and a completed onboarding are the same fact.
 */
export const AccountProfile = Schema.Struct({
  handle: AccountProfileHandle,
  displayName: TrimmedNonEmptyString,
  avatarColor: AccountProfileAvatarColor,
});
export type AccountProfile = typeof AccountProfile.Type;

export const AccountMe = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  image: Schema.optional(TrimmedNonEmptyString),
  /** The organization the caller's token is scoped to; hosts belong to it. */
  organization: OrganizationSummary,
  /**
   * The caller's Synara profile, or `null` when they have not onboarded.
   * Optional rather than required so a client built before profiles existed
   * still decodes a response from a server that sends them.
   */
  profile: Schema.optional(Schema.NullOr(AccountProfile)),
});
export type AccountMe = typeof AccountMe.Type;

/**
 * The body of `PUT /api/v1/profile`. `handle` is sent on every update even
 * though V1 refuses to change it: the client always knows the handle it is
 * writing, and accepting it lets the server answer a mismatch explicitly
 * rather than silently ignoring the field.
 */
export const UpdateProfileRequest = Schema.Struct({
  handle: AccountProfileHandle,
  displayName: TrimmedNonEmptyString,
  avatarColor: AccountProfileAvatarColor,
});
export type UpdateProfileRequest = typeof UpdateProfileRequest.Type;

/** The body of `PATCH /api/v1/organization` — the workspace rename. */
export const UpdateOrganizationRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type;

export const RegisterHostRequest = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  platform: AccountHostPlatform,
  kind: AccountHostKind,
  endpoints: Schema.Array(AccountHostEndpoint),
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type RegisterHostRequest = typeof RegisterHostRequest.Type;

export const RegisterHostResponse = Schema.Struct({
  host: AccountHost,
  hostToken: TrimmedNonEmptyString,
});
export type RegisterHostResponse = typeof RegisterHostResponse.Type;

export const UpdateHostRequest = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  endpoints: Schema.optional(Schema.Array(AccountHostEndpoint)),
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type UpdateHostRequest = typeof UpdateHostRequest.Type;

export const ListHostsResponse = Schema.Struct({
  hosts: Schema.Array(AccountHost),
});
export type ListHostsResponse = typeof ListHostsResponse.Type;

/**
 * What a client needs to talk to the identity provider this instance is wired
 * to. `workosApiUrl` travels alongside `clientId` because the device-flow poll
 * goes straight to WorkOS rather than through this service — a self-hoster
 * pointing at a stand-in origin would otherwise have no way to say so.
 */
export const InstanceInfo = Schema.Struct({
  version: TrimmedNonEmptyString,
  authMode: Schema.Literal("workos"),
  clientId: TrimmedNonEmptyString,
  workosApiUrl: TrimmedNonEmptyString,
});
export type InstanceInfo = typeof InstanceInfo.Type;

/** RFC 8628 device authorization response, camelCased. */
export const DeviceAuthorizationResponse = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
  userCode: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  verificationUriComplete: TrimmedNonEmptyString,
  expiresIn: Schema.Number,
  interval: Schema.Number,
});
export type DeviceAuthorizationResponse = typeof DeviceAuthorizationResponse.Type;

export const AccountErrorCode = Schema.Literals([
  "unauthorized",
  "host_not_found",
  "token_revoked",
  "signup_restricted",
  "organization_required",
  "environment_already_linked",
  "handle_taken",
  "validation_failed",
  "rate_limited",
  "internal_error",
]);
export type AccountErrorCode = typeof AccountErrorCode.Type;

export const AccountErrorBody = Schema.Struct({
  error: AccountErrorCode,
  message: TrimmedNonEmptyString,
});
export type AccountErrorBody = typeof AccountErrorBody.Type;

/**
 * The 403 a device token gets when it is not scoped to an organization the
 * caller belongs to — either it carries no `org_id` at all (every device-grant
 * token, since WorkOS mints those org-less) or it names one the caller has
 * since left. It is not a dead end: `organizations` lists what the caller can
 * refresh into, so the client re-runs the refresh grant with one of them and
 * retries. Distinct from {@link AccountErrorBody} by that list alone, which is
 * why the client must try this shape first.
 */
export const OrganizationRequiredBody = Schema.Struct({
  error: Schema.Literal("organization_required"),
  message: TrimmedNonEmptyString,
  organizations: Schema.Array(OrganizationSummary),
});
export type OrganizationRequiredBody = typeof OrganizationRequiredBody.Type;

// ── In-app account session (server-brokered, not the CLI) ────────────
//
// The app never holds account credentials itself: the server owns the stored
// credential file and every WorkOS round trip, and the schemas below are what
// it reports over the WebSocket RPC. That is why sign-in is two calls rather
// than a polling loop in the browser — the server does the waiting.

/**
 * Whether this machine currently has a usable account session, and who it
 * belongs to. Deliberately not a boolean plus a nullable user: a signed-in
 * state without an identity is not representable.
 */
export const AccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("signed-out") }),
  Schema.Struct({ state: Schema.Literal("signed-in"), me: AccountMe }),
]);
export type AccountStatus = typeof AccountStatus.Type;

/**
 * What the sign-in modal needs to show. `verificationUriComplete` embeds the
 * user code, so the browser hand-off is one click; `userCode` is still shown
 * because the user must be able to confirm the code on the page matches, and
 * to type it in if the hand-off lands somewhere unexpected.
 */
export const AccountBeginSignInResult = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
  userCode: TrimmedNonEmptyString,
  verificationUriComplete: TrimmedNonEmptyString,
  expiresIn: Schema.Number,
  interval: Schema.Number,
});
export type AccountBeginSignInResult = typeof AccountBeginSignInResult.Type;

export const AccountCompleteSignInInput = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
});
export type AccountCompleteSignInInput = typeof AccountCompleteSignInInput.Type;

/**
 * The onboarding write. `workspaceName` renames the WorkOS organization, and
 * travels with the profile because onboarding presents them as one step; it is
 * optional so later edits to the profile alone do not have to restate it.
 */
export const AccountUpdateProfileInput = Schema.Struct({
  ...UpdateProfileRequest.fields,
  workspaceName: Schema.optional(TrimmedNonEmptyString),
});
export type AccountUpdateProfileInput = typeof AccountUpdateProfileInput.Type;

/**
 * The URL to hand to the system browser. Constrained to the verification URL
 * the account service just issued: the server refuses anything else, so this
 * method can never become a general "open any URL for me" primitive.
 */
export const AccountOpenVerificationUrlInput = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type AccountOpenVerificationUrlInput = typeof AccountOpenVerificationUrlInput.Type;

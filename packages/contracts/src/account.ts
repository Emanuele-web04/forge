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

export const AccountMe = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  image: Schema.optional(TrimmedNonEmptyString),
  /** The organization the caller's token is scoped to; hosts belong to it. */
  organization: OrganizationSummary,
});
export type AccountMe = typeof AccountMe.Type;

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

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

export const AccountHost = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  platform: AccountHostPlatform,
  kind: AccountHostKind,
  endpoints: Schema.Array(AccountHostEndpoint),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  createdAt: TrimmedNonEmptyString,
  lastSeenAt: TrimmedNonEmptyString,
});
export type AccountHost = typeof AccountHost.Type;

export const AccountMe = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  image: Schema.optional(TrimmedNonEmptyString),
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

export const AccountSessionSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
  lastActiveAt: Schema.optional(TrimmedNonEmptyString),
  userAgent: Schema.optional(TrimmedNonEmptyString),
  current: Schema.Boolean,
});
export type AccountSessionSummary = typeof AccountSessionSummary.Type;

export const ListSessionsResponse = Schema.Struct({
  sessions: Schema.Array(AccountSessionSummary),
});
export type ListSessionsResponse = typeof ListSessionsResponse.Type;

export const InstanceInfo = Schema.Struct({
  version: TrimmedNonEmptyString,
  authMethods: Schema.Struct({
    emailPassword: Schema.Boolean,
    social: Schema.Array(Schema.Literals(["github", "google", "apple", "microsoft"])),
  }),
  emailDelivery: Schema.Boolean,
  signupRestricted: Schema.Boolean,
});
export type InstanceInfo = typeof InstanceInfo.Type;

export const AccountErrorCode = Schema.Literals([
  "unauthorized",
  "host_not_found",
  "token_revoked",
  "signup_restricted",
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

import { Schema } from "effect";
import {
  CloudTaskId,
  CloudWorkspaceId,
  ConnectedRepositoryId,
  NonNegativeInt,
  OrganizationId,
  PositiveInt,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas";

// Cloud (SaaS) workspace contracts. Design source:
// `.plans/Blueprint_de_la_version_cloud.md` §7–§8. Schema-only —
// no runtime logic, kept in line with the `packages/contracts` role.

const CloudWorkspaceStatus = Schema.Literals([
  "provisioning",
  "ready",
  "suspended",
  "destroyed",
]);
export type CloudWorkspaceStatus = typeof CloudWorkspaceStatus.Type;

const CloudTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
]);
export type CloudTaskStatus = typeof CloudTaskStatus.Type;

const CloudRegion = TrimmedNonEmptyString;
export type CloudRegion = typeof CloudRegion.Type;

const CloudNetworkMode = Schema.Literals(["isolated", "restricted"]);
export type CloudNetworkMode = typeof CloudNetworkMode.Type;

const CloudIsolation = Schema.Literals(["container-hardened", "microvm"]);
export type CloudIsolation = typeof CloudIsolation.Type;

/** Roles are organization-scoped. They deliberately do not overlap with the
 * desktop server's `owner`/`client` pairing roles. */
export const CloudOrganizationRole = Schema.Literals(["owner", "admin", "member", "viewer"]);
export type CloudOrganizationRole = typeof CloudOrganizationRole.Type;

/** Identity providers used to sign into the cloud control plane. GitHub here
 * identifies a person; repository authorization remains a separate GitHub App
 * integration and must never reuse this browser credential. */
export const CloudIdentityProvider = Schema.Literals(["password", "google", "github"]);
export type CloudIdentityProvider = typeof CloudIdentityProvider.Type;

/**
 * Public API capabilities. These are evaluated by the cloud control plane, never trusted from
 * browser state alone. Keep values additive so already-issued tokens retain their meaning.
 */
export const CloudApiTokenScope = Schema.Literals([
  "cortex.ai.invoke",
  "projects.read",
  "projects.write",
  "workspaces.read",
  "workspaces.write",
  "repositories.read",
  "repositories.write",
  "tasks.read",
  "tasks.write",
  "organizations.read",
]);
export type CloudApiTokenScope = typeof CloudApiTokenScope.Type;

/** Metadata safe to return after creation. Raw credentials are deliberately absent. */
export const CloudApiToken = Schema.Struct({
  id: TrimmedNonEmptyString,
  organizationId: OrganizationId,
  userId: UserId,
  name: TrimmedNonEmptyString,
  prefix: TrimmedNonEmptyString,
  scopes: Schema.Array(CloudApiTokenScope),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastUsedAt: Schema.optional(Schema.DateTimeUtcFromString),
  revokedAt: Schema.optional(Schema.DateTimeUtcFromString),
});
export type CloudApiToken = typeof CloudApiToken.Type;

/** The one and only API response shape allowed to carry a raw token. */
export const CloudCreatedApiToken = Schema.Struct({
  token: CloudApiToken,
  secret: TrimmedNonEmptyString,
});
export type CloudCreatedApiToken = typeof CloudCreatedApiToken.Type;

export const CloudSignInInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  password: TrimmedNonEmptyString,
});
export type CloudSignInInput = typeof CloudSignInInput.Type;

export const CloudSignUpInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  password: TrimmedNonEmptyString,
  acceptedTermsAt: Schema.DateTimeUtcFromString,
});
export type CloudSignUpInput = typeof CloudSignUpInput.Type;

/** Deliberately excludes a bearer token: the control plane sets an opaque,
 * Secure, HttpOnly session cookie and keeps its raw value out of browser JS. */
export const CloudAuthSession = Schema.Struct({
  user: Schema.Struct({
    id: UserId,
    email: TrimmedNonEmptyString,
    emailVerified: Schema.Boolean,
  }),
  organizationId: Schema.optional(OrganizationId),
});
export type CloudAuthSession = typeof CloudAuthSession.Type;

export const CloudOrganization = Schema.Struct({
  id: OrganizationId,
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  personal: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
});
export type CloudOrganization = typeof CloudOrganization.Type;

export const CloudMembership = Schema.Struct({
  organizationId: OrganizationId,
  userId: UserId,
  role: CloudOrganizationRole,
  createdAt: Schema.DateTimeUtcFromString,
});
export type CloudMembership = typeof CloudMembership.Type;

export const CloudUser = Schema.Struct({
  id: UserId,
  email: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  avatarUrl: Schema.optional(Schema.String),
  emailVerifiedAt: Schema.optional(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
});
export type CloudUser = typeof CloudUser.Type;

export const CloudConnectedRepository = Schema.Struct({
  id: ConnectedRepositoryId,
  organizationId: OrganizationId,
  provider: Schema.Literal("github"),
  owner: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  defaultBranch: TrimmedNonEmptyString,
  installationId: TrimmedNonEmptyString,
  permissions: Schema.Literals(["read", "write", "admin"]),
  connectedAt: Schema.DateTimeUtcFromString,
});
export type CloudConnectedRepository = typeof CloudConnectedRepository.Type;

export const CloudWorkspaceQuotas = Schema.Struct({
  cpu: Schema.Number,
  cpuLimit: Schema.Number,
  memoryMb: PositiveInt,
  storageGb: PositiveInt,
  network: CloudNetworkMode,
});
export type CloudWorkspaceQuotas = typeof CloudWorkspaceQuotas.Type;

export const CloudWorkspaceRepository = Schema.Struct({
  connectedRepositoryId: ConnectedRepositoryId,
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
});
export type CloudWorkspaceRepository = typeof CloudWorkspaceRepository.Type;

export const CloudWorkspaceCheckout = Schema.Struct({
  path: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type CloudWorkspaceCheckout = typeof CloudWorkspaceCheckout.Type;

export const CloudWorkspaceLifecycle = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  lastActiveAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  destroyAt: Schema.DateTimeUtcFromString,
});
export type CloudWorkspaceLifecycle = typeof CloudWorkspaceLifecycle.Type;

export const CloudWorkspace = Schema.Struct({
  id: CloudWorkspaceId,
  organizationId: OrganizationId,
  name: TrimmedNonEmptyString,
  status: CloudWorkspaceStatus,
  region: CloudRegion,
  repository: Schema.optional(CloudWorkspaceRepository),
  checkout: CloudWorkspaceCheckout,
  quotas: CloudWorkspaceQuotas,
  lifecycle: CloudWorkspaceLifecycle,
  isolation: CloudIsolation,
});
export type CloudWorkspace = typeof CloudWorkspace.Type;

export const CloudCreateWorkspaceInput = Schema.Struct({
  organizationId: OrganizationId,
  connectedRepositoryId: ConnectedRepositoryId,
  name: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  region: CloudRegion,
});
export type CloudCreateWorkspaceInput = typeof CloudCreateWorkspaceInput.Type;

export const CloudCreateTaskInput = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  title: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
});
export type CloudCreateTaskInput = typeof CloudCreateTaskInput.Type;

export const CloudTask = Schema.Struct({
  id: CloudTaskId,
  workspaceId: CloudWorkspaceId,
  title: TrimmedNonEmptyString,
  status: CloudTaskStatus,
  turn: NonNegativeInt,
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
});
export type CloudTask = typeof CloudTask.Type;

const CloudEventType = Schema.Literals([
  "task.update",
  "git.update",
  "runtime.update",
  "quota.warning",
  "session.expiring",
]);
export type CloudEventType = typeof CloudEventType.Type;

export const CloudEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  workspaceId: CloudWorkspaceId,
  taskId: Schema.optional(CloudTaskId),
  type: CloudEventType,
  at: Schema.DateTimeUtcFromString,
  payload: Schema.Unknown,
});
export type CloudEvent = typeof CloudEvent.Type;

// Planned interaction surface between control plane and execution plane
// (design sketch §8 — not wired to any transport yet).
export const CloudProvisionWorkspaceInput = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  organizationId: OrganizationId,
});
export type CloudProvisionWorkspaceInput = typeof CloudProvisionWorkspaceInput.Type;

export const CloudProvisionWorkspaceResult = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
});
export type CloudProvisionWorkspaceResult = typeof CloudProvisionWorkspaceResult.Type;

export const CloudRunnerHeartbeat = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  cpu: Schema.Number,
  memoryMb: NonNegativeInt,
});
export type CloudRunnerHeartbeat = typeof CloudRunnerHeartbeat.Type;

export const CloudTerminateWorkspaceInput = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  reason: Schema.Literals(["user-request", "expired", "quota-exceeded", "security-incident"]),
});
export type CloudTerminateWorkspaceInput = typeof CloudTerminateWorkspaceInput.Type;

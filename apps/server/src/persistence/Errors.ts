import { Schema, SchemaIssue } from "effect";

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError => {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = cause;
    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      if (current instanceof Error && current.message && !messages.includes(current.message)) {
        messages.push(current.message);
      }
      current = "cause" in current ? (current as { readonly cause?: unknown }).cause : undefined;
    }
    const causeDetail = messages.length > 0 ? ` (${messages.join(": ")})` : "";
    return new PersistenceSqlError({
      operation,
      detail: `Failed to execute ${operation}${causeDetail}`,
      cause,
    });
  };
}

export function toPersistenceDecodeError(operation: string) {
  return (error: Schema.SchemaError): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
): (cause: unknown) => PersistenceSqlError | PersistenceDecodeError {
  return (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause,
    });
}

/**
 * The projection cursor table is non-empty but a projector the snapshot
 * sequence depends on has no cursor row. The snapshot fence is unknowable in
 * this state: reporting any number would either serve stale data as fresh or
 * demand an unsatisfiable resnapshot forever. Reachable only through an
 * interrupted projection rebuild (repair/restore), so it names the missing
 * cursors and points at the recovery path instead of guessing.
 */
export class ProjectionStateIncompleteError extends Schema.TaggedErrorClass<ProjectionStateIncompleteError>()(
  "ProjectionStateIncompleteError",
  {
    missingProjectors: Schema.Array(Schema.String),
    knownProjectors: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return (
      `Projection state is incomplete: missing cursor rows for ${this.missingProjectors.join(", ")} ` +
      `(present: ${this.knownProjectors.join(", ") || "none"}). ` +
      "The snapshot sequence cannot be derived; restart the server so the projection " +
      "bootstrap can rebuild the missing cursors, or run repair local state."
    );
  }
}

export const isPersistenceError = (u: unknown) =>
  Schema.is(PersistenceSqlError)(u) ||
  Schema.is(PersistenceDecodeError)(u) ||
  Schema.is(ProjectionStateIncompleteError)(u);

export class MigrationLineageError extends Schema.TaggedErrorClass<MigrationLineageError>()(
  "MigrationLineageError",
  {
    firstDivergedId: Schema.Number,
    expectedName: Schema.String,
    recordedName: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Migration tracker does not match any known lineage: migration ${this.firstDivergedId} ` +
      `is recorded as "${this.recordedName}" but Synara expects "${this.expectedName}". ` +
      `Refusing to run migrations against an unrecognized database.`
    );
  }
}

export class MigrationSchemaTooNewError extends Schema.TaggedErrorClass<MigrationSchemaTooNewError>()(
  "MigrationSchemaTooNewError",
  {
    databaseMigrationId: Schema.Number,
    latestSupportedMigrationId: Schema.Number,
  },
) {
  override get message(): string {
    return (
      `Database schema migration ${this.databaseMigrationId} is newer than this Synara build ` +
      `(latest supported migration: ${this.latestSupportedMigrationId}). ` +
      "Refusing writable startup; upgrade Synara or restore a compatible database backup."
    );
  }
}

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ProjectionStateIncompleteError;

export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type AutomationRepositoryError = PersistenceSqlError | PersistenceDecodeError;

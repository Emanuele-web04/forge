import { SchemaIssue, Schema } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class OrchestrationCommandInvariantError extends Schema.TaggedErrorClass<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedErrorClass<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

export class OrchestrationCommandIdentityCollisionError extends Schema.TaggedErrorClass<OrchestrationCommandIdentityCollisionError>()(
  "OrchestrationCommandIdentityCollisionError",
  {
    commandId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command identity collision (${this.commandId}): ${this.detail}`;
  }
}

export class OrchestrationCommandTimeoutError extends Schema.TaggedErrorClass<OrchestrationCommandTimeoutError>()(
  "OrchestrationCommandTimeoutError",
  {
    commandId: Schema.String,
    commandType: Schema.String,
    timeoutMs: Schema.Number,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration command timed out (${this.commandType}, ${this.commandId}) after ${this.timeoutMs}ms`;
  }
}

export class OrchestrationCommandAdmissionError extends Schema.TaggedErrorClass<OrchestrationCommandAdmissionError>()(
  "OrchestrationCommandAdmissionError",
  {
    commandId: Schema.String,
    commandType: Schema.String,
    capacity: Schema.Number,
    reservedCapacity: Schema.Number,
    reason: Schema.Literals(["overloaded", "stopped"]),
  },
) {
  override get message(): string {
    return this.reason === "stopped"
      ? `Orchestration command admission is stopped (${this.commandType}, ${this.commandId})`
      : `Orchestration command queue is overloaded (${this.commandType}, ${this.commandId}); capacity ${this.capacity}, reserved ${this.reservedCapacity}`;
  }
}

export class OrchestrationCommandInternalError extends Schema.TaggedErrorClass<OrchestrationCommandInternalError>()(
  "OrchestrationCommandInternalError",
  {
    commandId: Schema.String,
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration command failed unexpectedly (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedErrorClass<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandAdmissionError
  | OrchestrationCommandInvariantError
  | OrchestrationCommandInternalError
  | OrchestrationCommandIdentityCollisionError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationCommandTimeoutError
  | OrchestrationProjectorDecodeError;

export function toProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

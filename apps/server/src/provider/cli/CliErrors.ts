// FILE: CliErrors.ts
// Purpose: Typed errors for the KAR-527 generic CLI connector.
// Layer: Server CLI connector errors
// Exports: CliSpawnError, CliTransportError, CliProtocolError, CliError

import { Schema } from "effect";

/**
 * The CLI process could not be spawned (missing binary, permission denied, ...).
 * Environment/configuration fault — never the CLI's behavior.
 */
export class CliSpawnError extends Schema.TaggedErrorClass<CliSpawnError>()("CliSpawnError", {
  command: Schema.optional(Schema.String),
  cause: Schema.Defect,
}) {
  override get message() {
    return this.command
      ? `Failed to spawn CLI process for command: ${this.command}`
      : "Failed to spawn CLI process";
  }
}

/**
 * The CLI process channel failed in a way that is not a protocol violation:
 * an unexpected stream write error, a process that died before announcing
 * anything, or a broken pipe. The agent is behaving badly enough that this is
 * attributed to the agent at the connector boundary, but the *form* of the
 * failure is transport-level rather than a framing violation.
 */
export class CliTransportError extends Schema.TaggedErrorClass<CliTransportError>()(
  "CliTransportError",
  {
    detail: Schema.String,
    cause: Schema.Defect,
  },
) {}

/**
 * A structured CLI emitted a line that the NDJSON wire protocol does not
 * permit: non-JSON text, a JSON value that is not an object (or not a known
 * event), an unknown event `type`, a known `type` with invalid fields, or a
 * protocol version the connector refuses. The offending line is preserved for
 * attribution so the caller can report exactly what the agent said.
 */
export class CliProtocolError extends Schema.TaggedErrorClass<CliProtocolError>()(
  "CliProtocolError",
  {
    detail: Schema.String,
    line: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    return `Structured CLI emitted a framing violation (${this.detail}): ${this.line.slice(0, 200)}`;
  }
}

export const CliError = Schema.Union([CliSpawnError, CliTransportError, CliProtocolError]);
export type CliError = typeof CliError.Type;

/**
 * All typed CLI connector errors. The runtime fails through these classes and
 * the conformance grader classifies them by `_tag` (CliSpawnError →
 * inconclusive/environment, CliProtocolError / CliTransportError → fail/agent),
 * so every constructed failure must be one of these members. `CliError` is
 * both the runtime's failure channel and the schema the connector boundary
 * persists; it is checked exhaustively whenever the shape is narrowed.
 */
export type CliErrorTyped = CliSpawnError | CliTransportError | CliProtocolError;

import { Schema } from "effect";

import { CapabilityId } from "./capabilityEvidence";

/**
 * KAR-527 generic CLI connector wire protocol.
 *
 * A *structured* CLI is a process that speaks newline-delimited JSON (NDJSON)
 * on stdout — one JSON object per line — and accepts commands on stdin the same
 * way. Every byte the CLI emits is checked against this contract:
 *
 * - each non-blank stdout line must be one JSON object;
 * - the object must decode as one of the `CliStructuredEvent` members;
 * - any other line (non-JSON, JSON array/primitive, unknown event `type`,
 *   or a known `type` with invalid fields) is a framing violation and is
 *   attributed to the agent — the connector never soft-skips it.
 *
 * Commands are the mirror image on stdin and are framed with the same rules.
 *
 * The protocol version is part of the contract: a CLI that does not announce
 * `protocolVersion: 1` on `session.hello` is not speaking this protocol and
 * fails attributionally rather than being treated as compatible.
 */

/** The only wire version the connector speaks. Bump means breaking framing rules. */
export const CLI_STRUCTURED_PROTOCOL_VERSION = 1;

const CliTurnId = Schema.String.check(Schema.isMaxLength(512));

/**
 * `session.hello` — first stdout event. Announces the agent and which canonical
 * capabilities it actually supports. Capability claims here are declarative:
 * the connector never assumes a specific provider's capability set, so a CLI
 * that stays silent advertises no optional capabilities and gets a smaller
 * (but honest) surface.
 */
const CliSessionHello = Schema.Struct({
  type: Schema.Literal("session.hello"),
  protocolVersion: Schema.Literal(CLI_STRUCTURED_PROTOCOL_VERSION),
  agentName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  agentVersion: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  capabilityIds: Schema.Array(CapabilityId).pipe(Schema.withDecodingDefault(() => [])),
});

/** A turn started answering a `cli.command.turn.start`. */
const CliTurnStarted = Schema.Struct({
  type: Schema.Literal("turn.started"),
  turnId: CliTurnId,
});

/** A streamed text delta for an in-flight turn. */
const CliTurnText = Schema.Struct({
  type: Schema.Literal("turn.text"),
  turnId: CliTurnId,
  text: Schema.String,
});

/** Normal completion of a turn. */
const CliTurnCompleted = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  turnId: CliTurnId,
  stopReason: Schema.Literal("end_turn"),
});

/** The CLI acknowledged a `cli.command.cancel` for an in-flight turn. */
const CliTurnCancelled = Schema.Struct({
  type: Schema.Literal("turn.cancelled"),
  turnId: CliTurnId,
});

/** The CLI reports a turn failed (agent fault, but well-formed). */
const CliTurnFailed = Schema.Struct({
  type: Schema.Literal("turn.failed"),
  turnId: CliTurnId,
  message: Schema.String,
});

/**
 * Every stdout event a structured CLI may emit. Strict: an event with an
 * unknown `type` is a framing violation, never silently ignored (structured
 * output either conforms to the contract or the connector fails attributably).
 */
export const CliStructuredEvent = Schema.Union([
  CliSessionHello,
  CliTurnStarted,
  CliTurnText,
  CliTurnCompleted,
  CliTurnCancelled,
  CliTurnFailed,
]);
export type CliStructuredEvent = typeof CliStructuredEvent.Type;

/** The canonical event names a structured CLI must be able to emit. */
export const CLI_STRUCTURED_EVENT_TYPES = [
  "session.hello",
  "turn.started",
  "turn.text",
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
] as const;

/** Optional greeting the connector can send to negotiate the protocol version. */
const CliCommandHello = Schema.Struct({
  type: Schema.Literal("cli.command.hello"),
  protocolVersion: Schema.Literal(CLI_STRUCTURED_PROTOCOL_VERSION),
});

/** Starts a turn with a unique turn id and prompt text. */
const CliCommandTurnStart = Schema.Struct({
  type: Schema.Literal("cli.command.turn.start"),
  turnId: CliTurnId,
  prompt: Schema.String,
});

/** Asks the CLI to cancel the in-flight turn. */
const CliCommandCancel = Schema.Struct({
  type: Schema.Literal("cli.command.cancel"),
  turnId: CliTurnId,
});

/**
 * Every stdin command the connector may send to a structured CLI. Commands are
 * framed exactly like events (one JSON object per NDJSON line).
 */
export const CliStructuredCommand = Schema.Union([
  CliCommandHello,
  CliCommandTurnStart,
  CliCommandCancel,
]);
export type CliStructuredCommand = typeof CliStructuredCommand.Type;

/** The canonical command names the connector may emit. */
export const CLI_STRUCTURED_COMMAND_TYPES = [
  "cli.command.hello",
  "cli.command.turn.start",
  "cli.command.cancel",
] as const;

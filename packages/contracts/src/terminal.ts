import { Schema } from "effect";
import { ProcessEnvRecord, TrimmedNonEmptyString } from "./baseSchemas";

export const DEFAULT_TERMINAL_ID = "default";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

// Dimension bounds for a PTY window. The OS `winsize` fields (`ws_col`/`ws_row`)
// are unsigned 16-bit, so the only hard ceiling is 65535; these caps stay well
// below that while comfortably covering ultrawide displays at small font sizes
// (legitimate fits can exceed 400 columns). The lower bounds keep a usable shell.
export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MAX_COLS = 2000;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_MAX_ROWS = 1000;

const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(TERMINAL_MIN_COLS)).check(
  Schema.isLessThanOrEqualTo(TERMINAL_MAX_COLS),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(TERMINAL_MIN_ROWS)).check(
  Schema.isLessThanOrEqualTo(TERMINAL_MAX_ROWS),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvSchema = ProcessEnvRecord;

const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(
  Schema.withDecodingDefault(() => DEFAULT_TERMINAL_ID),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = Schema.Codec.Encoded<typeof TerminalThreadInput>;

const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdWithDefaultSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  // When false, the PTY is still drained and history is still maintained, but
  // live `output` events are not broadcast. Used for headless background
  // sessions (e.g. dev servers) whose output no renderer consumes. Defaults to
  // true so interactive terminals stream as usual.
  streamOutput: Schema.optional(Schema.Boolean),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalAckOutputInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(8_388_608)),
});
export type TerminalAckOutputInput = Schema.Codec.Encoded<typeof TerminalAckOutputInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = Schema.Codec.Encoded<typeof TerminalCloseInput>;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  replayPreamble: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
  byteLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  cliKind: Schema.NullOr(
    Schema.Union([
      Schema.Literal("codex"),
      Schema.Literal("claude"),
      Schema.Literal("antigravity"),
      Schema.Literal("commandcode"),
    ]),
  ),
  agentState: Schema.NullOr(
    Schema.Union([
      Schema.Literal("running"),
      Schema.Literal("attention"),
      Schema.Literal("review"),
    ]),
  ),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

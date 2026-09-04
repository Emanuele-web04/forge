// FILE: CliStructuredRuntime.test.ts
// Purpose: KAR-527 runtime behavior tests for the generic CLI connector.
// Covers AC #1 (structured fixture streams + cancels), AC #2 (basic fixture
// honest limits: stream + process-tree cancel, never fake resume/permissions),
// AC #3 (malformed structured output fails attributably), and the framing
// contract itself (per-line NDJSON strictness, unknown types rejected, no
// soft-skipping). Real fixture executables are spawned under NodeServices.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe } from "vitest";

import {
  CliStructuredRuntime,
  validateStructuredLine,
  type CliStructuredRuntimeShape,
} from "./CliStructuredRuntime.ts";
import * as CliErrors from "./CliErrors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pure framing validation (AC #3)

describe("structured CLI framing validation", () => {
  it("accepts every canonical event on its own NDJSON line", () => {
    const lines = [
      `{"type":"session.hello","protocolVersion":1,"capabilityIds":[]}`,
      `{"type":"turn.started","turnId":"t1"}`,
      `{"type":"turn.text","turnId":"t1","text":"hello"}`,
      `{"type":"turn.completed","turnId":"t1","stopReason":"end_turn"}`,
      `{"type":"turn.cancelled","turnId":"t1"}`,
      `{"type":"turn.failed","turnId":"t1","message":"boom"}`,
    ];
    for (const line of lines) {
      assert.isUndefined(validateStructuredLine(line));
    }
  });

  it("ignores blank lines", () => {
    assert.isUndefined(validateStructuredLine(""));
    assert.isUndefined(validateStructuredLine("   "));
  });

  it("rejects a non-JSON line and returns a CliProtocolError carrying it", () => {
    const violation = validateStructuredLine("random agent chatter");
    assert.isDefined(violation);
    assert.instanceOf(violation, CliErrors.CliProtocolError);
    assert.match(violation!.line, /random agent chatter/);
  });

  it("rejects a JSON array and a bare JSON primitive", () => {
    const arrayViolation = validateStructuredLine("[1,2,3]");
    assert.isDefined(arrayViolation);
    assert.match(arrayViolation!.detail, /not an object/);

    const primitiveViolation = validateStructuredLine("42");
    assert.isDefined(primitiveViolation);
    assert.match(primitiveViolation!.detail, /not an object/);
  });

  it("rejects an unknown event type instead of soft-skipping it", () => {
    const violation = validateStructuredLine(`{"type":"turn.unknown","turnId":"t1"}`);
    assert.isDefined(violation);
    assert.match(violation!.detail, /not a known structured CLI event/);
  });

  it("rejects a known type with malformed fields", () => {
    const violation = validateStructuredLine(`{"type":"turn.started","prompt":"x"}`);
    assert.isDefined(violation);
  });

  it("rejects a turn.completed with a non-end_turn stop reason", () => {
    const violation = validateStructuredLine(
      `{"type":"turn.completed","turnId":"t1","stopReason":"cancelled"}`,
    );
    assert.isDefined(violation);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime integration helpers (AC #1, #2, #3)

const structuredFixture = (env: Record<string, string> = {}) =>
  CliStructuredRuntime.layer({
    spawn: {
      command: process.execPath,
      args: [new URL("../../../scripts/cli-structured-agent.ts", import.meta.url).pathname],
      env: { ...process.env, ...env, VITEST: "true" },
    },
    structured: true,
    startupTimeoutMs: 5_000,
    cancelAckGraceMs: 300,
  });

const basicFixture = (env: Record<string, string> = {}) =>
  CliStructuredRuntime.layer({
    spawn: {
      command: process.execPath,
      args: [new URL("../../../scripts/cli-basic-agent.ts", import.meta.url).pathname],
      env: { ...process.env, ...env, VITEST: "true" },
    },
    structured: false,
    startupTimeoutMs: 5_000,
    cancelAckGraceMs: 300,
  });

const runWithFixture = <A, E>(
  layer: ReturnType<typeof structuredFixture> | ReturnType<typeof basicFixture>,
  body: (runtime: CliStructuredRuntimeShape) => Effect.Effect<A, E>,
): Effect.Effect<A, never> =>
  Effect.gen(function* () {
    const runtime = yield* CliStructuredRuntime;
    return yield* body(runtime);
  })
    .pipe(Effect.provide(layer), Effect.scoped, Effect.provide(NodeServices.layer))
    .pipe(Effect.orDie);

// ─────────────────────────────────────────────────────────────────────────────
// Structured tier: stream + cancel (AC #1)

describe("structured CLI tier (AC #1)", () => {
  it("streams a full turn: hello, started, text deltas, completed", async () => {
    const events = await Effect.runPromise(
      runWithFixture(structuredFixture({ SYNARA_CLI_STRUCTURED_HELLO_TEXT: "steam" }), (runtime) =>
        Effect.gen(function* () {
          const started = yield* runtime.start();
          assert.equal(started.tier, "structured");
          yield* runtime.sendCommand({
            type: "cli.command.turn.start",
            turnId: "t-full",
            prompt: "build me a widget",
          });
          return yield* runtime
            .getEvents()
            .pipe(Stream.take(6), Stream.runCollect, Effect.timeout("5 seconds"));
        }),
      ),
    );
    const tags = (events as ReadonlyArray<any>).map((event) =>
      event._tag === "structured" ? event.event.type : event._tag,
    );
    assert.include(tags, "session.hello");
    assert.include(tags, "turn.started");
    assert.include(tags, "turn.text");
    assert.include(tags, "turn.completed");
    const texts = (events as ReadonlyArray<any>)
      .filter((event) => event._tag === "structured" && event.event.type === "turn.text")
      .map((event) => event.event.text);
    assert.isAtLeast(texts.length, 1);
    assert.include(texts[0], "steam");
  });

  it("honors a cancel command on an in-flight turn through the protocol ack", async () => {
    await Effect.runPromise(
      runWithFixture(
        // Slow text keeps the turn in-flight long enough (600ms) for the
        // cancel at ~150ms to arrive while `turn.cancelled` can still be the
        // terminal event. With the default 15ms fixture the turn would already
        // have completed and no `turn.cancelled` would exist to observe.
        structuredFixture({ SYNARA_CLI_STRUCTURED_TEXT_DELAY_MS: "200" }),
        (runtime) =>
          Effect.gen(function* () {
            const started = yield* runtime.start();
            assert.equal(started.tier, "structured");
            yield* runtime.sendCommand({
              type: "cli.command.turn.start",
              turnId: "t-cancel",
              prompt: "slow work",
            });
            yield* Effect.sleep("150 millis");
            // The cooperative fixture acks the cancel with `turn.cancelled`, so
            // cancel must end the turn through the protocol: the ack arrives
            // inside the grace window and the terminal event becomes observable.
            yield* runtime.cancel;
            const collected = yield* runtime
              .getEvents()
              .pipe(
                Stream.takeUntil((event) => event._tag !== "structured"),
                Stream.runCollect,
              )
              .pipe(Effect.timeout("5 seconds"));
            const events = collected as ReadonlyArray<any>;
            const cancelledSeen = events.some(
              (event) => event._tag === "structured" && event.event.type === "turn.cancelled",
            );
            assert.isTrue(cancelledSeen, "expected turn.cancelled after acked cancel");
          }),
      ),
    );
  });

  it("an ignore-cancel agent still gets process-tree teardown", async () => {
    await Effect.runPromise(
      runWithFixture(structuredFixture({ SYNARA_CLI_STRUCTURED_IGNORE_CANCEL: "1" }), (runtime) =>
        Effect.gen(function* () {
          const started = yield* runtime.start();
          assert.equal(started.tier, "structured");
          yield* runtime.sendCommand({
            type: "cli.command.turn.start",
            turnId: "t-cancel-ignore",
            prompt: "slow work",
          });
          yield* Effect.sleep("150 millis");
          // The fixture never acks `cli.command.cancel`, so the runtime must
          // fall back to tree teardown after the ack-grace window. This must
          // complete (the ack wait is bounded by cancelAckGraceMs) and must
          // not surface a turn.cancelled.
          yield* runtime.cancel;
        }),
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic tier: honest limits (AC #2)

describe("basic CLI tier (AC #2)", () => {
  it("starts on the first readiness line and streams echoed lines", async () => {
    const events = await Effect.runPromise(
      runWithFixture(basicFixture({ SYNARA_CLI_BASIC_GREETING: "ready" }), (runtime) =>
        Effect.gen(function* () {
          const started = yield* runtime.start();
          assert.equal(started.tier, "basic");
          assert.equal(started.capabilityIds.length, 0);
          // The basic tier has no command protocol: driving it is a raw stdin line.
          yield* runtime.sendInput("hello");
          return yield* runtime
            .getEvents()
            .pipe(Stream.take(3), Stream.runCollect, Effect.timeout("5 seconds"));
        }),
      ),
    );
    const lines = (events as ReadonlyArray<any>)
      .filter((event) => event._tag === "line")
      .map((event) => event.line);
    assert.ok(
      lines.some((line) => line.includes("hello")),
      `expected echo line, got ${String(lines.join(" | "))}`,
    );
  });

  it("cancels via process-tree teardown without a protocol acknowledgement", async () => {
    await Effect.runPromise(
      runWithFixture(basicFixture({ SYNARA_CLI_BASIC_HANG_ON_PROMPT: "1" }), (runtime) =>
        Effect.gen(function* () {
          const started = yield* runtime.start();
          assert.equal(started.tier, "basic");
          yield* runtime.sendInput("block forever");
          yield* Effect.sleep("150 millis");
          // The basic tier never answers a protocol cancel; cancellation is the
          // honest process-tree teardown. This must complete without error.
          yield* runtime.cancel;
        }),
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed structured output (AC #3)

describe("mid-stream framing violations (AC #3)", () => {
  it("attributes a non-JSON line emitted mid-turn after the hello", async () => {
    const failure = await Effect.gen(function* () {
      const runtime = yield* CliStructuredRuntime;
      yield* runtime.start();
      yield* runtime.sendCommand({
        type: "cli.command.turn.start",
        turnId: "t-mid",
        prompt: "ping",
      });
      const events = yield* runtime
        .getEvents()
        .pipe(Stream.take(5), Stream.runCollect, Effect.timeout("5 seconds"));
      return events;
    }).pipe(
      Effect.provide(structuredFixture({ SYNARA_CLI_STRUCTURED_MALFORMED_AFTER_HELLO: "1" })),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    const events = failure as ReadonlyArray<any>;
    const violation = events.find((event) => event?._tag === "protocol-error") as
      | { error?: { line?: string } }
      | undefined;
    assert.isDefined(violation, `expected a protocol-error event, got ${JSON.stringify(events)}`);
    assert.match(String(violation?.error?.line ?? ""), /random mid-stream chatter/);
  });
});

describe("malformed structured output attribution (AC #3)", () => {
  const malformedLayer = (mode: string) =>
    CliStructuredRuntime.layer({
      spawn: {
        command: process.execPath,
        args: [new URL("../../../scripts/cli-structured-agent.ts", import.meta.url).pathname],
        env: { ...process.env, SYNARA_CLI_STRUCTURED_MALFORMED: mode, VITEST: "true" },
      },
      structured: true,
      startupTimeoutMs: 5_000,
      cancelAckGraceMs: 300,
    });

  const startFailureTag = (mode: string): Promise<string | undefined> =>
    Effect.gen(function* () {
      const runtime = yield* CliStructuredRuntime;
      yield* runtime.start();
    })
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          const tag =
            typeof error === "object" && error !== null
              ? ((error as { _tag?: unknown })._tag as string | undefined)
              : undefined;
          return tag;
        }),
      )
      .pipe(
        Effect.provide(malformedLayer(mode)),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.runPromise,
      );

  it("turns a non-JSON startup line into a CliProtocolError at start", async () => {
    const tag = await startFailureTag("non-json");
    assert.equal(tag, "CliProtocolError");
  });

  it("turns an unknown-type startup line into a CliProtocolError", async () => {
    const tag = await startFailureTag("unknown-type");
    assert.equal(tag, "CliProtocolError");
  });

  it("rejects a hello announcing an unsupported protocol version", async () => {
    const tag = await startFailureTag("wrong-version");
    assert.equal(tag, "CliProtocolError");
  });
});

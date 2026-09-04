#!/usr/bin/env bun
// FILE: cli-structured-agent.ts
// Purpose: Deterministic structured-CLI fixture for the KAR-527 generic CLI
// connector. Speaks the Synara structured CLI wire protocol (NDJSON on stdout,
// commands on stdin — see packages/contracts/src/cliConnector.ts). Env knobs
// (SYNARA_CLI_STRUCTURED_*) select fault modes so integration tests can force
// the connector to produce attributable failures without ever naming a Synara
// provider.
// Layer: Test fixture executable
// Exports: none; communicates over NDJSON stdio.

import { createInterface } from "node:readline";

// Self-contained wire-protocol constants and types. The fixture deliberately
// does NOT import @synara/contracts so it can run under plain Node in tests
// (the contracts package uses Bun-only extensionless relative imports). It
// speaks the documented NDJSON wire protocol with its own copy of version 1.
const CLI_STRUCTURED_PROTOCOL_VERSION = 1;

type CliStructuredEvent =
  | {
      type: "session.hello";
      protocolVersion: number;
      agentName?: string;
      agentVersion?: string;
      capabilityIds?: readonly string[];
    }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.text"; turnId: string; text: string }
  | { type: "turn.completed"; turnId: string; stopReason: "end_turn" }
  | { type: "turn.cancelled"; turnId: string }
  | { type: "turn.failed"; turnId: string; message: string };

type CliStructuredCommand =
  | { type: "cli.command.hello"; protocolVersion: number }
  | { type: "cli.command.turn.start"; turnId: string; prompt: string }
  | { type: "cli.command.cancel"; turnId: string };

const helloText = process.env.SYNARA_CLI_STRUCTURED_HELLO_TEXT ?? "hello from structured cli";
const helloCount = Number(process.env.SYNARA_CLI_STRUCTURED_HELLO_COUNT ?? "3");
const failTurns = process.env.SYNARA_CLI_STRUCTURED_FAIL_TURNS === "1";
const malformedMode = process.env.SYNARA_CLI_STRUCTURED_MALFORMED ?? "none";
// Emits one malformed (non-JSON) line mid-turn, after the hello: closes AC3's
// mid-stream gap (non-JSON was only testable at startup before).
const malformedAfterHello = process.env.SYNARA_CLI_STRUCTURED_MALFORMED_AFTER_HELLO === "1";
const emitCancelled = process.env.SYNARA_CLI_STRUCTURED_EMIT_CANCELLED !== "0";
const ignoreCancel = process.env.SYNARA_CLI_STRUCTURED_IGNORE_CANCEL === "1";
const slowTextDelayMs = Number(process.env.SYNARA_CLI_STRUCTURED_TEXT_DELAY_MS ?? "5");
const advertisedCapabilities: readonly string[] =
  process.env.SYNARA_CLI_STRUCTURED_CAPABILITIES === undefined
    ? ["prompt", "stream", "cancel"]
    : process.env.SYNARA_CLI_STRUCTURED_CAPABILITIES.split(",").flatMap((entry) => {
        const trimmed = entry.trim();
        if (
          trimmed === "prompt" ||
          trimmed === "stream" ||
          trimmed === "cancel" ||
          trimmed === "session.start" ||
          trimmed === "session.resume" ||
          trimmed === "permissions" ||
          trimmed === "elicitation" ||
          trimmed === "tool.events" ||
          trimmed === "model.discovery" ||
          trimmed === "model.switch" ||
          trimmed === "modes" ||
          trimmed === "usage" ||
          trimmed === "terminal.state"
        ) {
          return [trimmed];
        }
        return [];
      });

function emit(event: CliStructuredEvent, { waitMs = 0 }: { waitMs?: number } = {}): void {
  if (waitMs > 0) {
    const timer = setTimeout(() => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }, waitMs);
    timer.unref();
    return;
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitHello(): void {
  emit({
    type: "session.hello",
    protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION,
    agentName: "synara-cli-structured-fixture",
    agentVersion: "1.0.0",
    capabilityIds: advertisedCapabilities,
  });
}

// Startup fault modes run before the hello, so the connector sees them on the
// first stdout read.
if (malformedMode === "non-json") {
  // A line that is not JSON at all: strict framing must attribute it to the agent.
  process.stdout.write("random agent chatter\n");
} else if (malformedMode === "json-array") {
  // Valid JSON but not an object event: also a framing violation.
  process.stdout.write("[1,2,3]\n");
} else if (malformedMode === "unknown-type") {
  // An object with a `type` the wire contract does not know.
  process.stdout.write(JSON.stringify({ type: "turn.unknown", turnId: "t0" }) + "\n");
} else if (malformedMode === "wrong-version") {
  // Announces a protocol version the connector does not speak.
  emit({
    type: "session.hello",
    protocolVersion: 2,
  } as unknown as CliStructuredEvent);
} else {
  emitHello();
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const inFlight = new Set<string>();

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;

  let command: CliStructuredCommand;
  try {
    command = JSON.parse(line) as CliStructuredCommand;
  } catch {
    // A malformed command on stdin is a bug in the connector, not the fixture.
    process.stderr.write(`fixture received non-JSON command: ${line}\n`);
    return;
  }

  switch (command.type) {
    case "cli.command.hello":
      // The connector sends `cli.command.hello` after we already emit
      // `session.hello`; acknowledge to keep the round-trip explicit.
      emit({
        type: "session.hello",
        protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION,
        capabilityIds: advertisedCapabilities,
      });
      break;

    case "cli.command.turn.start": {
      const { turnId, prompt } = command;
      inFlight.add(turnId);
      if (failTurns) {
        emit({
          type: "turn.failed",
          turnId,
          message: `intentional failure for ${prompt.slice(0, 40)}`,
        });
        break;
      }
      emit({ type: "turn.started", turnId });
      // Mid-stream framing violation: emit the bad line after the hello, so the
      // connector sees a well-formed start followed by an attributable fault.
      if (malformedAfterHello) {
        process.stdout.write("random mid-stream chatter\n");
        inFlight.delete(turnId);
        break;
      }
      if (slowTextDelayMs > 0) {
        // A per-line delay gives cancel a window to land: the turn is kept
        // in-flight for the full delayed-text duration and `turn.completed` is
        // only emitted after the last delayed text has flushed — the same
        // eventual completion as without the delay, but with `cli.command.cancel`
        // still able to win the race and produce a `turn.cancelled` ack.
        emit({ type: "turn.text", turnId, text: helloText }, { waitMs: slowTextDelayMs });
        for (let i = 1; i < helloCount; i++) {
          emit(
            { type: "turn.text", turnId, text: `${helloText} ${i}` },
            { waitMs: slowTextDelayMs },
          );
        }
        const finishAt = setTimeout(
          () => {
            if (!inFlight.has(turnId)) return;
            inFlight.delete(turnId);
            emit({ type: "turn.completed", turnId, stopReason: "end_turn" });
          },
          slowTextDelayMs * helloCount + 1,
        );
        finishAt.unref();
      } else {
        emit({ type: "turn.text", turnId, text: helloText }, { waitMs: slowTextDelayMs });
        for (let i = 1; i < helloCount; i++) {
          emit(
            { type: "turn.text", turnId, text: `${helloText} ${i}` },
            { waitMs: slowTextDelayMs },
          );
        }
        const finishAt = setTimeout(() => {
          inFlight.delete(turnId);
          emit({ type: "turn.completed", turnId, stopReason: "end_turn" });
        }, slowTextDelayMs * helloCount);
        finishAt.unref();
      }
      break;
    }

    case "cli.command.cancel": {
      const { turnId } = command;
      if (ignoreCancel) break;
      // `turnId: "all"` is the connector's wildcard: cancel every in-flight
      // turn. Exact ids cancel just that turn.
      const targets = turnId === "all" ? [...inFlight] : [turnId];
      for (const target of targets) {
        if (inFlight.has(target)) {
          inFlight.delete(target);
          if (emitCancelled) {
            emit({ type: "turn.cancelled", turnId: target });
          }
        }
      }
      break;
    }
  }
});

process.once("SIGTERM", () => {
  process.exit(0);
});
process.once("SIGINT", () => {
  process.exit(0);
});

// Keep this process alive until stdin closes (the connector owns the pipe).

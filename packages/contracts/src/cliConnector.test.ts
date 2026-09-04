// FILE: cliConnector.test.ts
// Purpose: KAR-527 contract tests. Covers AC #4 (schema rejects bad mappings)
// and framing strictness of the structured CLI wire protocol: every stdout line
// must decode as a known event, unknown `type`s and malformed members are
// rejected, and commands round-trip on the same framing rules.

import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ExternalAgentProfileCreateInput,
  AgentProfileRevision as AgentProfileRevisionSchema,
} from "./externalAgent";
import {
  CLI_STRUCTURED_COMMAND_TYPES,
  CLI_STRUCTURED_EVENT_TYPES,
  CLI_STRUCTURED_PROTOCOL_VERSION,
  CliStructuredCommand,
  CliStructuredEvent,
} from "./cliConnector";

describe("Agent profile connector-kind ↔ launch mapping (AC #4)", () => {
  const commandLaunch = (frameMode: "ndjson" | "line") => ({
    kind: "command" as const,
    command: "my-cli",
    frameMode,
  });

  it("accepts a cli-structured profile with an ndjson command launch", () => {
    const input = {
      name: "s",
      displayName: "Structured CLI",
      connectorKind: "cli-structured",
      launch: commandLaunch("ndjson"),
    };
    expect(Schema.is(ExternalAgentProfileCreateInput)(input)).toBe(true);
    const decoded = Schema.decodeUnknownSync(ExternalAgentProfileCreateInput)(input);
    expect(decoded.launch.kind === "command" && decoded.launch.frameMode).toBe("ndjson");
  });

  it("accepts a cli-basic profile with a line command launch", () => {
    const input = {
      name: "b",
      displayName: "Basic CLI",
      connectorKind: "cli-basic",
      launch: commandLaunch("line"),
    };
    expect(Schema.is(ExternalAgentProfileCreateInput)(input)).toBe(true);
  });

  it("rejects a cli-structured profile using line framing", () => {
    const input = {
      name: "s",
      displayName: "Structured CLI",
      connectorKind: "cli-structured",
      launch: commandLaunch("line"),
    };
    expect(Schema.is(ExternalAgentProfileCreateInput)(input)).toBe(false);
    expect(() => Schema.decodeUnknownSync(ExternalAgentProfileCreateInput)(input)).toThrow(
      /frame mode/,
    );
  });

  it("rejects a cli-basic profile using ndjson framing", () => {
    const input = {
      name: "b",
      displayName: "Basic CLI",
      connectorKind: "cli-basic",
      launch: commandLaunch("ndjson"),
    };
    expect(Schema.is(ExternalAgentProfileCreateInput)(input)).toBe(false);
    expect(() => Schema.decodeUnknownSync(ExternalAgentProfileCreateInput)(input)).toThrow(
      /frame mode/,
    );
  });

  it("rejects a cli-tier profile using an endpoint launch", () => {
    const input = {
      name: "s",
      displayName: "Structured CLI",
      connectorKind: "cli-structured",
      launch: { kind: "endpoint", endpoint: "http://localhost:1234" },
    };
    expect(Schema.is(ExternalAgentProfileCreateInput)(input)).toBe(false);
    expect(() => Schema.decodeUnknownSync(ExternalAgentProfileCreateInput)(input)).toThrow(
      /frame mode/,
    );
  });

  it("rejects a cli-tier profile with no frameMode on the command launch", () => {
    const input = {
      name: "s",
      displayName: "Structured CLI",
      connectorKind: "cli-structured",
      launch: { kind: "command", command: "my-cli" },
    };
    expect(Schema.is(ExternalAgentProfileCreateInput)(input)).toBe(false);
  });

  it("keeps legacy ACP profile revisions decoding without a frameMode", () => {
    // The persisted shape for ACP profiles never carries frameMode; the schema
    // must not break existing rows.
    const revision = {
      revisionId: "rev_1",
      displayName: "Legacy ACP Agent",
      connectorKind: "acp",
      launch: { kind: "command", command: "acp", args: [] },
      credentialRefs: [],
      provenance: { source: "legacy-settings-acp" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(Schema.is(AgentProfileRevisionSchema)(revision)).toBe(true);
  });
});

describe("structured CLI wire protocol framing", () => {
  it("announces the protocol version and capabilities", () => {
    const event = Schema.decodeUnknownSync(CliStructuredEvent)({
      type: "session.hello",
      protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION,
      agentName: "my-cli",
      capabilityIds: ["prompt", "stream", "cancel"],
    });
    expect(event.type).toBe("session.hello");
    if (event.type === "session.hello") {
      expect(event.capabilityIds).toEqual(["prompt", "stream", "cancel"]);
    }
  });

  it("defaults a hello with no capability ids to an empty list", () => {
    const event = Schema.decodeUnknownSync(CliStructuredEvent)({
      type: "session.hello",
      protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION,
    });
    expect(event.type).toBe("session.hello");
    if (event.type === "session.hello") {
      expect(event.capabilityIds).toEqual([]);
    }
  });

  it("rejects a hello with the wrong protocol version", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredEvent)({
        type: "session.hello",
        protocolVersion: 2,
      }),
    ).toThrow(/protocolVersion/);
  });

  it("rejects a hello that advertises an unknown capability id", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredEvent)({
        type: "session.hello",
        protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION,
        capabilityIds: ["definitely-not-a-capability"],
      }),
    ).toThrow(/terminal\.state/);
  });

  it("round-trips an event stream of a full turn", () => {
    const lines = [
      { type: "session.hello", protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION },
      { type: "turn.started", turnId: "t1" },
      { type: "turn.text", turnId: "t1", text: "hello" },
      { type: "turn.completed", turnId: "t1", stopReason: "end_turn" },
    ];
    for (const line of lines) {
      const event = Schema.decodeUnknownSync(CliStructuredEvent)(line);
      expect(event.type).toBe(line.type);
    }
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredEvent)({ type: "turn.unknown", turnId: "t1" }),
    ).toThrow(/Expected/);
  });

  it("rejects a known type with invalid fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredEvent)({ type: "turn.started", prompt: "x" }),
    ).toThrow(/turnId/);
  });

  it("rejects a turn.completed with a stop reason other than end_turn", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredEvent)({
        type: "turn.completed",
        turnId: "t1",
        stopReason: "cancelled",
      }),
    ).toThrow(/stopReason/);
  });

  it("round-trips commands the connector may send", () => {
    const commands = [
      { type: "cli.command.hello", protocolVersion: CLI_STRUCTURED_PROTOCOL_VERSION },
      { type: "cli.command.turn.start", turnId: "t1", prompt: "do it" },
      { type: "cli.command.cancel", turnId: "t1" },
    ];
    for (const command of commands) {
      const decoded = Schema.decodeUnknownSync(CliStructuredCommand)(command);
      expect(decoded.type).toBe(command.type);
    }
  });

  it("rejects commands with unknown or malformed members", () => {
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredCommand)({ type: "cli.command.cancel" }),
    ).toThrow(/turnId/);
    expect(() =>
      Schema.decodeUnknownSync(CliStructuredCommand)({ type: "cli.command.wat" }),
    ).toThrow(/Expected/);
  });

  it("exposes the canonical event and command type names", () => {
    expect(CLI_STRUCTURED_EVENT_TYPES).toHaveLength(6);
    expect(CLI_STRUCTURED_COMMAND_TYPES).toEqual([
      "cli.command.hello",
      "cli.command.turn.start",
      "cli.command.cancel",
    ]);
  });
});

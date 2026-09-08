import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OutboundMcpConnection } from "./outboundMcp";

describe("OutboundMcpConnection", () => {
  it("decodes a disconnected preset without credentials", () => {
    expect(
      Schema.decodeUnknownSync(OutboundMcpConnection)({
        id: "paraty",
        presetId: "paraty",
        displayName: "Paraty MCP",
        endpoint: "https://mcp-paraty-224371693889.europe-west1.run.app/mcp",
        status: "disconnected",
        lastValidatedAt: null,
        errorCategory: null,
      }).status,
    ).toBe("disconnected");
  });

  it.each([
    "http://mcp.example.test/mcp",
    "file:///tmp/mcp.sock",
    "ws://mcp.example.test/mcp",
    "not-a-url",
  ])("rejects the non-HTTPS endpoint %s", (endpoint) => {
    expect(() =>
      Schema.decodeUnknownSync(OutboundMcpConnection)({
        id: "paraty",
        presetId: "paraty",
        displayName: "Paraty MCP",
        endpoint,
        status: "disconnected",
        lastValidatedAt: null,
        errorCategory: null,
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { makeFrameKindEchoRpcSerialization } from "./host";

function request(id: string): string {
  return JSON.stringify({
    _tag: "Request",
    id,
    tag: "e2e.echo",
    payload: { sequence: 0, payload: "echo" },
    headers: [],
  });
}

function response(requestId: string) {
  return {
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value: { sequence: 0, payload: "echo" } },
  };
}

describe("e2e echo RPC serialization", () => {
  it("echoes each request's text or binary WebSocket frame kind", () => {
    const parser = makeFrameKindEchoRpcSerialization().makeUnsafe();

    parser.decode(request("0"));
    parser.decode(Buffer.from(request("1")));

    expect(parser.encode(response("0"))).toEqual(JSON.stringify(response("0")));
    expect(parser.encode(response("1"))).toEqual(
      new TextEncoder().encode(JSON.stringify(response("1"))),
    );
  });
});

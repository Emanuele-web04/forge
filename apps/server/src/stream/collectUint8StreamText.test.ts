import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { collectUint8StreamText } from "./collectUint8StreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamText", () => {
  it("collects stream chunks into text", async () => {
    const result = await Effect.runPromise(
      collectUint8StreamText({
        stream: Stream.fromIterable([encoder.encode("hello "), encoder.encode("world")]),
      }),
    );

    expect(result).toEqual({
      text: "hello world",
      truncated: false,
    });
  });

  it("truncates by bytes while continuing to drain the stream", async () => {
    const result = await Effect.runPromise(
      collectUint8StreamText({
        stream: Stream.fromIterable([encoder.encode("hello"), encoder.encode(" world")]),
        maxBytes: 7,
      }),
    );

    expect(result).toEqual({
      text: "hello w",
      truncated: true,
    });
  });

  it("does not mark an exact-limit stream truncated for a trailing empty chunk", async () => {
    const result = await Effect.runPromise(
      collectUint8StreamText({
        stream: Stream.fromIterable([encoder.encode("hello"), new Uint8Array()]),
        maxBytes: 5,
      }),
    );

    expect(result).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  it("still marks a later non-empty chunk truncated after an empty chunk", async () => {
    const result = await Effect.runPromise(
      collectUint8StreamText({
        stream: Stream.fromIterable([
          encoder.encode("hello"),
          new Uint8Array(),
          encoder.encode("!"),
        ]),
        maxBytes: 5,
      }),
    );

    expect(result).toEqual({
      text: "hello",
      truncated: true,
    });
  });

  it("does not emit a replacement character when truncation splits a UTF-8 sequence", async () => {
    const result = await Effect.runPromise(
      collectUint8StreamText({
        stream: Stream.fromIterable([encoder.encode("ab€cd")]),
        maxBytes: 4,
      }),
    );

    expect(result).toEqual({
      text: "ab",
      truncated: true,
    });
    expect(result.text).not.toContain("�");
  });

  it("drops an incomplete four-byte UTF-8 suffix at the byte limit", async () => {
    const result = await Effect.runPromise(
      collectUint8StreamText({
        stream: Stream.fromIterable([encoder.encode("ok🙂done")]),
        maxBytes: 5,
      }),
    );

    expect(result).toEqual({
      text: "ok",
      truncated: true,
    });
  });
});

import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
} from "./codexAppServerTransport.ts";

describe("Codex app-server transport", () => {
  it("frames split UTF-8 and rejects invalid, oversize, or unterminated input", () => {
    const framer = new CodexJsonlFramer(64);
    const encoded = Buffer.from('{"text":"A😀B"}\r\n{"id":2}\n', "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("😀", "utf8"));

    expect(framer.push(encoded.subarray(0, emojiStart + 2))).toEqual([]);
    expect(framer.push(encoded.subarray(emojiStart + 2))).toEqual(['{"text":"A😀B"}', '{"id":2}']);
    framer.finish();
    expect(framer.bufferedBytes).toBe(0);

    expect(() => new CodexJsonlFramer(8).push(Buffer.from("123456789"))).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );

    const unterminated = new CodexJsonlFramer(64);
    unterminated.push(Buffer.from('{"id":1}'));
    expect(() => unterminated.finish()).toThrowError(
      expect.objectContaining({ reason: "unterminated-frame" }),
    );

    expect(() => new CodexJsonlFramer(64).push(Buffer.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ reason: "invalid-utf8" }),
    );
  });

  it("serializes slow stdin writes within one retained-byte budget", async () => {
    class ControlledWritable extends EventEmitter {
      writable = true;
      autoComplete = false;
      readonly chunks: Array<Buffer> = [];
      readonly callbacks: Array<(error?: Error | null) => void> = [];

      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.chunks.push(Buffer.from(chunk));
        if (this.autoComplete) {
          queueMicrotask(() => callback());
          return true;
        }
        this.callbacks.push(callback);
        return false;
      }

      release(): void {
        this.autoComplete = true;
        for (const callback of this.callbacks.splice(0)) callback();
        this.emit("drain");
      }
    }

    const stream = new ControlledWritable();
    const writer = new CodexJsonlWriter(stream as unknown as Writable, 64, 120);
    const messages = [1, 2, 3].map((id) => ({ id, payload: "x".repeat(16) }));
    const writes = messages.map((message) => writer.write(message));

    expect(stream.chunks).toHaveLength(1);
    expect(writer.bufferedBytes).toBeLessThanOrEqual(120);
    await expect(writer.write({ id: 4, payload: "x".repeat(16) })).rejects.toMatchObject({
      reason: "write-overloaded",
    });
    expect(writer.bufferedBytes).toBeLessThanOrEqual(120);

    stream.release();
    await Promise.all(writes);
    expect(writer.bufferedBytes).toBe(0);
    expect(stream.chunks.map((chunk) => JSON.parse(chunk.toString("utf8")))).toEqual(messages);

    const blockedStream = new ControlledWritable();
    const blockedWriter = new CodexJsonlWriter(blockedStream as unknown as Writable, 64, 120);
    const blockedWrite = blockedWriter.write({ id: "blocked" });
    blockedWriter.close(new Error("session stopped"));
    await expect(blockedWrite).rejects.toThrow("session stopped");
    expect(blockedWriter.bufferedBytes).toBe(0);
  });

  it("reports typed output frame errors", async () => {
    const stream = new EventEmitter() as EventEmitter & {
      writable: boolean;
      write: Writable["write"];
    };
    stream.writable = true;
    stream.write = (() => true) as Writable["write"];
    const writer = new CodexJsonlWriter(stream as unknown as Writable, 16, 32);

    await expect(writer.write({ payload: "x".repeat(32) })).rejects.toBeInstanceOf(
      CodexAppServerTransportError,
    );
  });

  it("uses the Codex-specific message in the error stack header", () => {
    const error = new CodexAppServerTransportError({
      reason: "frame-too-large",
      maxBytes: 16,
      observedBytes: 17,
    });

    expect(error.message).toBe("Codex app-server JSONL frame exceeded its byte limit (17/16).");
    expect(error.stack?.split("\n", 1)[0]).toContain(error.message);
  });
});

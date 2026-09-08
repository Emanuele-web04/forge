import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "./jsonrpc-stdio";

describe("shared JSON-RPC stdio transport", () => {
  it("frames split UTF-8 and reports framing failures", () => {
    const framer = new JsonRpcStdioFramer(64);
    const encoded = Buffer.from('{"text":"A😀B"}\r\n{"id":2}\n', "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("😀", "utf8"));

    expect(framer.push(encoded.subarray(0, emojiStart + 2))).toEqual([]);
    expect(framer.push(encoded.subarray(emojiStart + 2))).toEqual(['{"text":"A😀B"}', '{"id":2}']);
    framer.finish();

    expect(() => new JsonRpcStdioFramer(8).push(Buffer.from("123456789"))).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );
    expect(() => new JsonRpcStdioFramer(64).push(Buffer.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ reason: "invalid-utf8" }),
    );
  });

  it("stays usable after a framing failure instead of wedging on the leftovers", () => {
    const framer = new JsonRpcStdioFramer(8);

    expect(framer.push(Buffer.from("1234"))).toEqual([]);
    expect(() => framer.push(Buffer.from("56789"))).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );
    // The partial line used to be retained, so it both re-threw on every later
    // push and would have been spliced onto whatever line arrived next.
    expect(framer.bufferedBytes).toBe(0);
    expect(framer.push(Buffer.from('tail\n{"id":1}\n'))).toEqual(['{"id":1}']);
  });

  it("skips an oversized line across chunks and resumes at the next newline", () => {
    const errors: JsonRpcStdioTransportError[] = [];
    const framer = new JsonRpcStdioFramer(16, (error) => errors.push(error));

    expect(framer.push(Buffer.from("x".repeat(24)))).toEqual([]);
    expect(framer.push(Buffer.from("still the same oversized line"))).toEqual([]);
    expect(framer.push(Buffer.from('tail\n{"id":1}\n'))).toEqual(['{"id":1}']);

    // One report for one bad line, not one per chunk it spanned.
    expect(errors.map((error) => error.reason)).toEqual(["frame-too-large"]);
    expect(framer.bufferedBytes).toBe(0);
  });

  it("charges a bad line to itself and still returns its chunk's good frames", () => {
    const errors: JsonRpcStdioTransportError[] = [];
    const framer = new JsonRpcStdioFramer(64, (error) => errors.push(error));

    const frames = framer.push(
      Buffer.concat([
        Buffer.from('{"id":1}\n'),
        Buffer.from([0xff, 0x0a]),
        Buffer.from('{"id":2}\n'),
      ]),
    );

    expect(frames).toEqual(['{"id":1}', '{"id":2}']);
    expect(errors.map((error) => error.reason)).toEqual(["invalid-utf8"]);
  });

  it("permanently closes a framer and rejects pushes after terminal end", () => {
    const framer = new JsonRpcStdioFramer(64);
    framer.push(Buffer.from('{"id":1}'));
    framer.close();

    expect(() => framer.push(Buffer.from("\n"))).toThrowError(
      expect.objectContaining({ reason: "unterminated-frame" }),
    );
  });

  it("bounds queued writes and honors drain before resolving", async () => {
    class SlowWritable extends EventEmitter {
      writable = true;
      readonly chunks: Buffer[] = [];
      callback: ((error?: Error | null) => void) | undefined;

      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.chunks.push(Buffer.from(chunk));
        this.callback = callback;
        return false;
      }
    }

    const stream = new SlowWritable();
    const writer = new JsonRpcStdioWriter(stream as unknown as Writable, 64, 120);
    const write = writer.write({ id: 1, payload: "x".repeat(16) });
    expect(writer.bufferedBytes).toBeGreaterThan(0);
    expect(stream.chunks).toHaveLength(1);
    const second = writer.write({ id: 2, payload: "x".repeat(16) });
    let firstSettled = false;
    void write.then(() => {
      firstSettled = true;
    });
    stream.callback?.();
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    stream.emit("drain");
    await write;
    stream.callback?.();
    stream.emit("drain");
    await second;
    expect(writer.bufferedBytes).toBeGreaterThanOrEqual(0);
    writer.close();
  });

  it("rejects writes after close and when stdin closes mid-write", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const writer = new JsonRpcStdioWriter(stream, 64, 128);
    writer.close();
    await expect(writer.write({ id: 1 })).rejects.toMatchObject({ reason: "write-closed" });

    class ClosingWritable extends EventEmitter {
      writable = true;

      write(_chunk: Uint8Array, _callback: (error?: Error | null) => void): boolean {
        return false;
      }
    }

    const closingStream = new ClosingWritable();
    const closingWriter = new JsonRpcStdioWriter(closingStream as unknown as Writable, 64, 128);
    const pending = closingWriter.write({ id: 2 });
    closingStream.emit("close");
    await expect(pending).rejects.toThrow("JSON-RPC stdio stdin closed during write");
  });

  it("correlates responses, times out, and exposes respawn lifecycle hooks", async () => {
    const messages: unknown[] = [];
    const lifecycle = {
      spawned: [] as number[],
      respawned: [] as number[],
      exited: [] as Error[],
    };
    const registry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: 10,
      lifecycle: {
        onSpawn: (generation) => lifecycle.spawned.push(generation),
        onRespawn: (generation) => lifecycle.respawned.push(generation),
        onExit: (error) => lifecycle.exited.push(error),
      },
    });

    registry.processStarted();
    const result = registry.request("ping", { value: true }, (message) => {
      messages.push(message);
    });
    await Promise.resolve();
    expect(messages).toEqual([{ id: 1, method: "ping", params: { value: true } }]);
    expect(registry.handleResponse({ id: 1, result: "pong" })).toBe(true);
    await expect(result).resolves.toBe("pong");

    await expect(registry.request("slow", {}, () => undefined, 1)).rejects.toThrow(
      "Timed out waiting for slow.",
    );
    const exit = new Error("process exited");
    registry.processExited(exit);
    registry.processStarted();
    expect(lifecycle.spawned).toEqual([1, 2]);
    expect(lifecycle.respawned).toEqual([2]);
    expect(lifecycle.exited).toEqual([exit]);
  });

  it("writes a request synchronously before a following notification", async () => {
    const messages: unknown[] = [];
    const registry = new JsonRpcStdioRequestRegistry();
    const result = registry.request("request", {}, (message) => {
      messages.push(message);
    });

    messages.push({ method: "notification" });
    expect(messages).toEqual([
      { id: 1, method: "request", params: {} },
      { method: "notification" },
    ]);
    expect(registry.handleResponse({ id: 1, result: "ok" })).toBe(true);
    await expect(result).resolves.toBe("ok");
  });

  it("turns a synchronous write failure into a rejected request", async () => {
    const registry = new JsonRpcStdioRequestRegistry();
    const failure = new Error("write failed");
    let request: Promise<unknown> | undefined;

    expect(() => {
      request = registry.request("write", {}, () => {
        throw failure;
      });
    }).not.toThrow();
    await expect(request).rejects.toBe(failure);
    expect(registry.size).toBe(0);
  });

  it("rejects duplicate request ids and ignores unknown responses", async () => {
    const registry = new JsonRpcStdioRequestRegistry();
    const first = registry.requestWithId("same", "first", {}, () => undefined);

    await expect(registry.requestWithId("same", "duplicate", {}, () => undefined)).rejects.toThrow(
      'Duplicate JSON-RPC request id "same".',
    );
    expect(registry.handleResponse({ id: "unknown", result: true })).toBe(false);
    expect(registry.handleResponse({ id: "same", result: "done" })).toBe(true);
    await expect(first).resolves.toBe("done");
  });

  it("uses typed transport errors for oversized output", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const writer = new JsonRpcStdioWriter(stream, 16, 32);
    await expect(writer.write({ payload: "x".repeat(32) })).rejects.toBeInstanceOf(
      JsonRpcStdioTransportError,
    );
  });
});

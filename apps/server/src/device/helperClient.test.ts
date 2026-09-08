import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeDeviceFrame, encodeDeviceFrame } from "@synara/shared/deviceFrame";

import {
  DeviceFramePrefixParser,
  DeviceHelperError,
  HelperClient,
  encodeFrameRecord,
} from "./helperClient.ts";

const DEVICE = "FAKE-0001";

type ControlRequest = {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

type ControlResponseHandler = (
  child: {
    readonly stdout: { emit: (event: string, ...args: readonly unknown[]) => boolean };
    emit: (event: string, ...args: readonly unknown[]) => boolean;
  },
  request: ControlRequest,
) => void;

let nextResponseHandler: ControlResponseHandler | undefined;

vi.mock("node:child_process", () => {
  type Listener = (...args: readonly unknown[]) => void;

  class FakeEventEmitter {
    private readonly listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener): this {
      let listeners = this.listeners.get(event);
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(event, listeners);
      }
      listeners.add(listener);
      return this;
    }

    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: readonly unknown[]): boolean {
      const listeners = this.listeners.get(event);
      if (!listeners) return false;
      for (const listener of [...listeners]) listener(...args);
      return true;
    }
  }

  class FakeStream extends FakeEventEmitter {
    setEncoding(_encoding: string): void {}
  }

  class FakeStdin extends FakeEventEmitter {
    writable = true;

    constructor(private readonly onRequest: (request: ControlRequest) => void) {
      super();
    }

    write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
      callback();
      this.onRequest(JSON.parse(Buffer.from(chunk).toString("utf8")) as ControlRequest);
      return true;
    }

    end(): void {}
  }

  class FakeChild extends FakeEventEmitter {
    readonly stdout = new FakeStream();
    readonly stderr = new FakeStream();
    readonly stdin: FakeStdin;

    constructor() {
      super();
      this.stdin = new FakeStdin((request) => nextResponseHandler?.(this, request));
    }

    kill(_signal: NodeJS.Signals): boolean {
      this.emit("exit", null, "SIGTERM");
      return true;
    }
  }

  return {
    spawn: () => new FakeChild(),
  };
});

afterEach(() => {
  nextResponseHandler = undefined;
});

function makeControlClient(handler: ControlResponseHandler, requestTimeoutMs = 100): HelperClient {
  nextResponseHandler = handler;
  return new HelperClient({
    binaryPath: "fake-helper",
    requestTimeoutMs,
  });
}

/**
 * What the helper actually puts on the socket: the contract envelope, wrapped
 * in its own u32 length prefix.
 */
function record(
  options: {
    readonly sequence?: number;
    readonly keyframe?: boolean;
    readonly codecConfig?: boolean;
    readonly payload?: Uint8Array;
  } = {},
) {
  return encodeFrameRecord(
    encodeDeviceFrame({
      header: {
        deviceId: DEVICE,
        sequence: options.sequence ?? 1,
        timestampMs: 100,
        keyframe: options.keyframe ?? false,
        codecConfig: options.codecConfig ?? false,
      },
      payload: options.payload ?? new Uint8Array([1, 2, 3]),
    }),
  );
}

describe("helper frame prefix parser", () => {
  it("unwraps one whole record", () => {
    const parser = new DeviceFramePrefixParser();

    const payloads = parser.push(record({ sequence: 7, keyframe: true }));

    expect(payloads).toHaveLength(1);
    // The payload is passed through untouched: it is already the envelope the
    // transport and the browser decode.
    expect(payloads[0]!.byteLength).toBeGreaterThan(17);
  });

  it("reassembles a record split across chunks", () => {
    const parser = new DeviceFramePrefixParser();
    const bytes = record({ payload: new Uint8Array([4, 5, 6, 7]) });

    const first = parser.push(bytes.subarray(0, 3));
    const second = parser.push(bytes.subarray(3, 12));
    const third = parser.push(bytes.subarray(12));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(third[0]!.byteLength).toBe(bytes.byteLength - 4);
  });

  it("returns every record in a chunk carrying several", () => {
    const parser = new DeviceFramePrefixParser();

    const payloads = parser.push(
      Buffer.concat([
        record({ sequence: 1 }),
        record({ sequence: 2, keyframe: true }),
        record({ sequence: 3 }),
      ]),
    );

    expect(payloads).toHaveLength(3);
  });

  it("copies payloads so a later chunk cannot mutate an emitted frame", () => {
    const parser = new DeviceFramePrefixParser();
    const bytes = record({ payload: new Uint8Array([7, 7]) });

    const payloads = parser.push(bytes);
    const before = Array.from(payloads[0]!);
    bytes.fill(0);

    expect(Array.from(payloads[0]!)).toEqual(before);
  });

  it("rejects an implausible length prefix instead of allocating", () => {
    const parser = new DeviceFramePrefixParser();
    const desynced = Buffer.alloc(8);
    desynced.writeUInt32LE(0xff_ff_ff_ff, 0);

    expect(() => parser.push(desynced)).toThrow(DeviceHelperError);
  });

  it("emits nothing for a length prefix with no payload yet", () => {
    const parser = new DeviceFramePrefixParser();
    const prefixOnly = Buffer.alloc(4);
    prefixOnly.writeUInt32LE(64, 0);

    expect(parser.push(prefixOnly)).toHaveLength(0);
  });
});

describe("helper stdio control channel", () => {
  it("correlates responses and maps helper error codes", async () => {
    const client = makeControlClient((child, request) => {
      if (request.method === "echo") {
        setTimeout(
          () =>
            child.stdout.emit(
              "data",
              Buffer.from(JSON.stringify({ id: request.id, result: request.params.value }) + "\n"),
            ),
          Number(request.params.delay),
        );
      } else if (request.method === "fail") {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ id: request.id, error: { code: 17, message: "helper rejected" } }) +
              "\n",
          ),
        );
      }
    });
    try {
      const responses = await Promise.all([
        client.request("echo", { value: "slow", delay: 10 }),
        client.request("echo", { value: "fast", delay: 0 }),
      ]);
      expect(responses).toEqual(["slow", "fast"]);
      await expect(client.request("fail")).rejects.toMatchObject({
        code: "helper_17",
        message: "helper rejected",
      });
    } finally {
      await client.dispose();
    }
  });

  it("reports helper_timeout when a control request receives no response", async () => {
    const client = makeControlClient(() => undefined, 20);
    try {
      await expect(client.request("never")).rejects.toMatchObject({ code: "helper_timeout" });
    } finally {
      await client.dispose();
    }
  });

  it("reports the existing error for an oversized control line", async () => {
    const client = makeControlClient((child) => {
      child.stdout.emit("data", Buffer.from("x".repeat(4 * 1024 * 1024 + 1)));
    });
    try {
      await expect(client.request("oversized")).rejects.toMatchObject({
        code: "helper_protocol_error",
        message: "Device helper control line exceeded limit",
      });
    } finally {
      await client.dispose();
    }
  });

  it("keeps serving requests after an oversized control line", async () => {
    const client = makeControlClient((child, request) => {
      if (request.method === "oversized") {
        child.stdout.emit("data", Buffer.from(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`));
        return;
      }
      child.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ id: request.id, result: "ok" })}\n`),
      );
    });
    try {
      await expect(client.request("oversized")).rejects.toMatchObject({
        code: "helper_protocol_error",
      });
      // A protocol error costs the in-flight response, not the write path: the
      // helper is still running and the next call has to reach it.
      await expect(client.request("after")).resolves.toBe("ok");
    } finally {
      await client.dispose();
    }
  });

  it("ignores an undecodable control line without losing the response beside it", async () => {
    const client = makeControlClient((child, request) => {
      child.stdout.emit(
        "data",
        Buffer.concat([
          // Helper diagnostics that are not valid UTF-8, then the real response,
          // in one read.
          Buffer.from([0xff, 0xfe, 0x0a]),
          Buffer.from(`${JSON.stringify({ id: request.id, result: "survived" })}\n`),
        ]),
      );
    });
    try {
      await expect(client.request("noisy")).resolves.toBe("survived");
    } finally {
      await client.dispose();
    }
  });

  it("rejects a pending request when the helper exits", async () => {
    const client = makeControlClient((child) => {
      child.emit("exit", 7, null);
    });
    try {
      await expect(client.request("exit")).rejects.toMatchObject({ code: "helper_exited" });
    } finally {
      await client.dispose();
    }
  });
});

/**
 * The helper writes a full contract envelope and `DeviceFrameTransport`
 * re-encodes one with the routing device id it already has. Forwarding the
 * helper's record whole therefore leaves two headers in front of the access
 * unit, and every frame fails to decode in the browser with a bare "Decoding
 * error" — which is what shipped before this was caught end to end.
 */
describe("helper frame envelope handling", () => {
  it("yields an access unit the transport can re-envelope exactly once", () => {
    const accessUnit = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x33]);
    const parser = new DeviceFramePrefixParser();

    const [helperRecord] = parser.push(record({ payload: accessUnit, keyframe: true }));
    if (!helperRecord) throw new Error("expected one record");

    // What the socket handler does before handing the frame to the transport.
    const decoded = decodeDeviceFrame(helperRecord);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Array.from(decoded.frame.payload)).toEqual(Array.from(accessUnit));

    // What the transport then puts on the wire, and what the browser decodes.
    const republished = decodeDeviceFrame(
      encodeDeviceFrame({ header: decoded.frame.header, payload: decoded.frame.payload }),
    );
    expect(republished.ok).toBe(true);
    if (!republished.ok) return;
    expect(Array.from(republished.frame.payload)).toEqual(Array.from(accessUnit));
    expect(republished.frame.header.keyframe).toBe(true);
  });
});

describe("device point bounds", () => {
  const attachment = {
    udid: DEVICE,
    pointWidth: 402,
    pointHeight: 874,
    pixelWidth: 1206,
    pixelHeight: 2622,
    scale: 3,
    inputAvailable: true,
    accessibilityAvailable: true,
  };

  /** A client with a fixed attachment, so normalize() can be exercised alone. */
  const attachedClient = () => {
    const client = new HelperClient({ binaryPath: "/nonexistent" });
    (client as unknown as { attachment: typeof attachment }).attachment = attachment;
    return client;
  };

  it("maps in-bounds device points onto the 0..1 range the helper wants", () => {
    expect(attachedClient().normalize(201, 437)).toEqual({ x: 0.5, y: 0.5 });
    expect(attachedClient().normalize(0, 0)).toEqual({ x: 0, y: 0 });
    expect(attachedClient().normalize(402, 874)).toEqual({ x: 1, y: 1 });
  });

  it("rejects a coordinate past the right edge instead of clamping it", () => {
    // 1019 is a frame pixel on a 1206px canvas. Clamping pinned this to the
    // screen edge and reported success, which hid the whole pixel-vs-point bug.
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/outside the screen bounds/u);
  });

  it("rejects a coordinate past the bottom edge", () => {
    expect(() => attachedClient().normalize(200, 2000)).toThrow(/outside the screen bounds/u);
  });

  it("rejects negative and non-finite coordinates", () => {
    expect(() => attachedClient().normalize(-1, 100)).toThrow(/outside the screen bounds/u);
    expect(() => attachedClient().normalize(100, Number.NaN)).toThrow(/outside the screen bounds/u);
  });

  it("names the valid bounds and the scale so the caller can see the mistake", () => {
    // "1019 is outside 0..402 (402x874 at 3x)" makes the scale factor obvious.
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/0\.\.402/u);
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/402x874 points at 3x/u);
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/not frame pixels/u);
  });
});

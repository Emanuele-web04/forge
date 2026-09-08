export const FRAME_HEADER_FIXED_BYTES = 17;
export const FRAME_MAX_STREAM_ID_BYTES = 255;
export const FRAME_FLAG_KEYFRAME = 0b0000_0001;
export const FRAME_FLAG_CODEC_CONFIG = 0b0000_0010;

export type FrameDecodeErrorReason =
  | "too-short"
  | "bad-magic"
  | "unsupported-version"
  | "truncated-stream-id"
  | "invalid-stream-id";

export interface FrameHeader {
  readonly streamId: string;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

export interface FrameEnvelope {
  readonly header: FrameHeader;
  readonly payload: Uint8Array;
}

export interface FrameCodecConfig {
  readonly magic: number;
  readonly version: number;
  readonly streamIdLabel: string;
  readonly frameLabel: string;
  readonly maxStreamIdBytes?: number;
}

export type FrameDecodeResult =
  | { readonly ok: true; readonly frame: FrameEnvelope }
  | { readonly ok: false; readonly reason: FrameDecodeErrorReason };

export class FrameEncodeError extends Error {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const encodeFrameEnvelope = (config: FrameCodecConfig, frame: FrameEnvelope): Uint8Array => {
  const maxStreamIdBytes = config.maxStreamIdBytes ?? FRAME_MAX_STREAM_ID_BYTES;
  const streamIdBytes = textEncoder.encode(frame.header.streamId);
  if (streamIdBytes.byteLength === 0) {
    throw new FrameEncodeError(
      `${config.frameLabel} frame header requires a non-empty ${config.streamIdLabel}`,
    );
  }
  if (streamIdBytes.byteLength > maxStreamIdBytes) {
    throw new FrameEncodeError(
      `${config.frameLabel} frame ${config.streamIdLabel} exceeds ${maxStreamIdBytes} UTF-8 bytes`,
    );
  }

  const buffer = new ArrayBuffer(
    FRAME_HEADER_FIXED_BYTES + streamIdBytes.byteLength + frame.payload.byteLength,
  );
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let flags = 0;
  if (frame.header.keyframe) flags |= FRAME_FLAG_KEYFRAME;
  if (frame.header.codecConfig) flags |= FRAME_FLAG_CODEC_CONFIG;

  view.setUint16(0, config.magic, true);
  view.setUint8(2, config.version);
  view.setUint8(3, flags);
  view.setUint32(4, frame.header.sequence >>> 0, true);
  view.setFloat64(8, frame.header.timestampMs, true);
  view.setUint8(16, streamIdBytes.byteLength);
  bytes.set(streamIdBytes, FRAME_HEADER_FIXED_BYTES);
  bytes.set(frame.payload, FRAME_HEADER_FIXED_BYTES + streamIdBytes.byteLength);

  return bytes;
};

export const decodeFrameEnvelope = (
  config: FrameCodecConfig,
  bytes: Uint8Array,
): FrameDecodeResult => {
  if (bytes.byteLength < FRAME_HEADER_FIXED_BYTES) {
    return { ok: false, reason: "too-short" };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== config.magic) {
    return { ok: false, reason: "bad-magic" };
  }
  if (view.getUint8(2) !== config.version) {
    return { ok: false, reason: "unsupported-version" };
  }

  const flags = view.getUint8(3);
  const streamIdLength = view.getUint8(16);
  const payloadOffset = FRAME_HEADER_FIXED_BYTES + streamIdLength;
  if (streamIdLength === 0 || bytes.byteLength < payloadOffset) {
    return { ok: false, reason: "truncated-stream-id" };
  }

  let streamId: string;
  try {
    streamId = textDecoder.decode(bytes.subarray(FRAME_HEADER_FIXED_BYTES, payloadOffset));
  } catch {
    return { ok: false, reason: "invalid-stream-id" };
  }

  return {
    ok: true,
    frame: {
      header: {
        streamId,
        sequence: view.getUint32(4, true),
        timestampMs: view.getFloat64(8, true),
        keyframe: (flags & FRAME_FLAG_KEYFRAME) !== 0,
        codecConfig: (flags & FRAME_FLAG_CODEC_CONFIG) !== 0,
      },
      payload: bytes.subarray(payloadOffset),
    },
  };
};

export const peekFrameHeader = (
  config: FrameCodecConfig,
  bytes: Uint8Array,
): FrameHeader | null => {
  const result = decodeFrameEnvelope(config, bytes);
  return result.ok ? result.frame.header : null;
};

export interface FrameSink {
  readonly send: (bytes: Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly isOpen: () => boolean;
}

export interface FrameSubscriberStats {
  readonly sent: number;
  readonly dropped: number;
  readonly awaitingKeyframe: boolean;
  readonly queued: number;
}

export interface FrameTransportOptions<TStreamId extends string, TFrame> {
  readonly encode: (streamId: TStreamId, frame: TFrame) => Uint8Array;
  readonly queueLimit?: number;
  readonly socketBudgetBytes?: number;
  readonly subscriberIdPrefix?: string;
}

interface Subscriber<TStreamId extends string> {
  readonly id: string;
  readonly streamId: TStreamId;
  readonly sink: FrameSink;
  readonly queue: Uint8Array[];
  queuedBytes: number;
  awaitingKeyframe: boolean;
  sent: number;
  dropped: number;
}

/**
 * Bounded, keyframe-aware fan-out for any encoded frame stream.
 *
 * The transport retains only the latest codec-config and keyframe for late
 * subscribers. Slow subscribers drop their backlog and wait for a clean
 * keyframe rather than receiving undecodable delta frames.
 */
export class FrameTransport<TStreamId extends string, TFrame> {
  private readonly subscribers = new Map<string, Subscriber<TStreamId>>();
  private readonly subscribersByStream = new Map<string, Set<Subscriber<TStreamId>>>();
  private readonly latestKeyframe = new Map<string, Uint8Array>();
  private readonly codecConfig = new Map<string, Uint8Array>();
  private readonly queueLimit: number;
  private readonly socketBudgetBytes: number;
  private readonly encode: (streamId: TStreamId, frame: TFrame) => Uint8Array;
  private readonly subscriberIdPrefix: string;
  private nextSubscriberId = 1;

  constructor(options: FrameTransportOptions<TStreamId, TFrame>) {
    this.encode = options.encode;
    this.queueLimit = options.queueLimit ?? 8;
    this.socketBudgetBytes = options.socketBudgetBytes ?? 2 * 1024 * 1024;
    this.subscriberIdPrefix = options.subscriberIdPrefix ?? "frame-subscriber";
    if (!Number.isSafeInteger(this.queueLimit) || this.queueLimit <= 0) {
      throw new RangeError("Frame queue limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.socketBudgetBytes) || this.socketBudgetBytes < 0) {
      throw new RangeError("Frame socket budget must be a non-negative safe integer");
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  streamSubscriberCount(streamId: TStreamId): number {
    return this.subscribersByStream.get(streamId)?.size ?? 0;
  }

  subscribe(streamId: TStreamId, sink: FrameSink): () => void {
    const subscriber: Subscriber<TStreamId> = {
      id: `${this.subscriberIdPrefix}:${this.nextSubscriberId++}`,
      streamId,
      sink,
      queue: [],
      queuedBytes: 0,
      awaitingKeyframe: true,
      sent: 0,
      dropped: 0,
    };
    this.subscribers.set(subscriber.id, subscriber);
    let streamSubscribers = this.subscribersByStream.get(streamId);
    if (!streamSubscribers) {
      streamSubscribers = new Set();
      this.subscribersByStream.set(streamId, streamSubscribers);
    }
    streamSubscribers.add(subscriber);

    const config = this.codecConfig.get(streamId);
    if (config) this.deliver(subscriber, config);
    const keyframe = this.latestKeyframe.get(streamId);
    if (keyframe) {
      subscriber.awaitingKeyframe = false;
      this.deliver(subscriber, keyframe);
    }

    return () => this.removeSubscriber(subscriber);
  }

  publish(streamId: TStreamId, frame: TFrame): void {
    const encoded = this.encode(streamId, frame);
    const isCodecConfig = this.isCodecConfig(frame);
    const isKeyframe = this.isKeyframe(frame);

    if (isCodecConfig) this.codecConfig.set(streamId, encoded);
    else if (isKeyframe) this.latestKeyframe.set(streamId, encoded);

    const streamSubscribers = this.subscribersByStream.get(streamId);
    if (!streamSubscribers || streamSubscribers.size === 0) return;

    for (const subscriber of Array.from(streamSubscribers)) {
      if (!subscriber.sink.isOpen()) {
        this.removeSubscriber(subscriber);
        continue;
      }
      if (isCodecConfig) {
        this.deliver(subscriber, encoded, true);
        continue;
      }
      if (subscriber.awaitingKeyframe) {
        if (!isKeyframe) {
          subscriber.dropped += 1;
          continue;
        }
        subscriber.awaitingKeyframe = false;
      }
      this.deliver(subscriber, encoded);
    }
  }

  reset(streamId: TStreamId): void {
    this.latestKeyframe.delete(streamId);
    this.codecConfig.delete(streamId);
    for (const subscriber of this.subscribersByStream.get(streamId) ?? []) {
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
    }
  }

  statsFor(streamId: TStreamId): readonly FrameSubscriberStats[] {
    return [...(this.subscribersByStream.get(streamId) ?? [])].map((subscriber) => ({
      sent: subscriber.sent,
      dropped: subscriber.dropped,
      awaitingKeyframe: subscriber.awaitingKeyframe,
      queued: subscriber.queue.length,
    }));
  }

  private isCodecConfig(frame: TFrame): boolean {
    return isFrameMetadata(frame, "codecConfig");
  }

  private isKeyframe(frame: TFrame): boolean {
    return isFrameMetadata(frame, "keyframe");
  }

  private deliver(
    subscriber: Subscriber<TStreamId>,
    encoded: Uint8Array,
    /**
     * Codec config is never dropped outright (nothing decodes without it), but
     * it does not ride past the caps either: a stalled subscriber keeps exactly
     * one, the latest, in place of whatever backlog preceded it.
     */
    essential = false,
  ): void {
    if (!subscriber.sink.isOpen()) {
      this.removeSubscriber(subscriber);
      return;
    }

    if (subscriber.sink.bufferedAmount() <= this.socketBudgetBytes) {
      this.flush(subscriber);
      subscriber.sink.send(encoded);
      subscriber.sent += 1;
      return;
    }

    if (essential) {
      // A new config makes the queued frames moot: they belong to the old
      // config, and the decoder needs the keyframe that follows the new one.
      // Replacing the backlog also bounds a stall that sees config after
      // config, which would otherwise grow the queue without limit.
      subscriber.dropped += subscriber.queue.length;
      subscriber.queue.length = 0;
      subscriber.queue.push(encoded);
      subscriber.queuedBytes = encoded.byteLength;
      subscriber.awaitingKeyframe = true;
      return;
    }

    // The count cap alone let a backlog of huge keyframes grow unbounded
    // (eight frames x whatever a frame weighs), so the queue is bounded in
    // bytes too: whichever ceiling trips first drops the backlog.
    if (
      subscriber.queue.length >= this.queueLimit ||
      subscriber.queuedBytes + encoded.byteLength > this.socketBudgetBytes
    ) {
      subscriber.dropped += subscriber.queue.length + 1;
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
      return;
    }
    subscriber.queue.push(encoded);
    subscriber.queuedBytes += encoded.byteLength;
  }

  private flush(subscriber: Subscriber<TStreamId>): void {
    if (subscriber.queue.length === 0) return;
    for (const queued of subscriber.queue) {
      subscriber.sink.send(queued);
      subscriber.sent += 1;
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }

  private removeSubscriber(subscriber: Subscriber<TStreamId>): void {
    this.subscribers.delete(subscriber.id);
    const streamSubscribers = this.subscribersByStream.get(subscriber.streamId);
    streamSubscribers?.delete(subscriber);
    if (streamSubscribers && streamSubscribers.size === 0) {
      this.subscribersByStream.delete(subscriber.streamId);
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }
}

function isFrameMetadata(frame: unknown, key: "codecConfig" | "keyframe"): boolean {
  return (
    typeof frame === "object" && frame !== null && (frame as Record<string, unknown>)[key] === true
  );
}

export const decodeFrameResyncRequest = (
  message: string | Uint8Array,
  resyncMessage: string,
  maxBytes = 1_024,
): "resync" | null => {
  const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
  if (text.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === resyncMessage
      ? "resync"
      : null;
  } catch {
    return null;
  }
};

export const makeFrameSink = (options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): FrameSink => {
  let inFlightBytes = 0;
  return {
    send: (bytes) => {
      inFlightBytes += bytes.byteLength;
      const settle = () => {
        inFlightBytes = Math.max(0, inFlightBytes - bytes.byteLength);
      };
      const result = options.send(bytes);
      if (result instanceof Promise) result.then(settle, settle);
      else settle();
    },
    bufferedAmount: () => inFlightBytes,
    isOpen: options.isOpen,
  };
};

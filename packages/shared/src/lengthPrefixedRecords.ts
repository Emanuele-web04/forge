/**
 * Splitting `u32 little-endian length` + payload records out of a byte stream.
 *
 * A native helper that pushes binary payloads at the server — the iOS device
 * helper over a unix socket today — frames them this way, because a pipe or
 * socket delivers arbitrary chunks and the envelope inside is not
 * self-delimiting. The payload is passed through
 * untouched: it is already a frame envelope, and decoding it here would
 * duplicate the codec that owns that job.
 */

export const LENGTH_PREFIX_BYTES = 4;
/** Default ceiling on one record, past which the stream is treated as desynced. */
export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export class LengthPrefixedRecordError extends Error {
  readonly declaredBytes: number;
  readonly maxBytes: number;

  constructor(declaredBytes: number, maxBytes: number) {
    super(`Length-prefixed record claims ${declaredBytes} bytes, past the ${maxBytes} byte limit`);
    this.name = "LengthPrefixedRecordError";
    this.declaredBytes = declaredBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Accumulates chunks and yields whole records.
 *
 * A record larger than the limit throws rather than being skipped: the length is
 * read from the same bytes that would have to be trusted to find the next
 * record, so an implausible length means the reader has lost the framing and
 * cannot resynchronize. The caller drops the connection.
 */
export class LengthPrefixedRecordParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxRecordBytes: number = DEFAULT_MAX_RECORD_BYTES) {}

  /** Every complete payload now available, in order. */
  push(chunk: Uint8Array): readonly Uint8Array[] {
    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const payloads: Uint8Array[] = [];
    while (this.buffer.byteLength >= LENGTH_PREFIX_BYTES) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxRecordBytes) {
        throw new LengthPrefixedRecordError(length, this.maxRecordBytes);
      }
      const total = LENGTH_PREFIX_BYTES + length;
      if (this.buffer.byteLength < total) break;
      // Copied: the payload outlives this parse and `this.buffer` is reassigned.
      payloads.push(
        Uint8Array.prototype.slice.call(this.buffer, LENGTH_PREFIX_BYTES, total) as Uint8Array,
      );
      this.buffer = this.buffer.subarray(total);
    }
    return payloads;
  }
}

/** Frames a payload the way the helpers do. Used by the tests and by fakes. */
export function encodeLengthPrefixedRecord(payload: Uint8Array): Buffer {
  const record = Buffer.alloc(LENGTH_PREFIX_BYTES + payload.byteLength);
  record.writeUInt32LE(payload.byteLength, 0);
  record.set(payload, LENGTH_PREFIX_BYTES);
  return record;
}

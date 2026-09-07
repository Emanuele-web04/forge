import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
}

interface CollectState {
  readonly chunks: Uint8Array[];
  readonly byteLength: number;
  readonly truncated: boolean;
}

function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1;
  if ((leadByte & 0xe0) === 0xc0) return 2;
  if ((leadByte & 0xf0) === 0xe0) return 3;
  if ((leadByte & 0xf8) === 0xf0) return 4;
  return 1;
}

function trimIncompleteUtf8Suffix(bytes: Buffer): Buffer {
  if (bytes.length === 0) return bytes;

  let sequenceStart = bytes.length - 1;
  while (sequenceStart >= 0 && (bytes[sequenceStart]! & 0xc0) === 0x80) {
    sequenceStart -= 1;
  }
  if (sequenceStart < 0) return bytes;

  const expectedLength = utf8SequenceLength(bytes[sequenceStart]!);
  const availableLength = bytes.length - sequenceStart;
  return expectedLength > availableLength ? bytes.subarray(0, sequenceStart) : bytes;
}

export function collectUint8StreamText<E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number;
}): Effect.Effect<CollectedUint8StreamText, E> {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  return Stream.runFold(
    input.stream,
    (): CollectState => ({ chunks: [], byteLength: 0, truncated: false }),
    (state, chunk) => {
      if (state.truncated || chunk.byteLength === 0) {
        return state;
      }

      const remaining = maxBytes - state.byteLength;
      if (remaining <= 0) {
        return { ...state, truncated: true };
      }

      const nextChunk = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      state.chunks.push(nextChunk);
      return {
        chunks: state.chunks,
        byteLength: state.byteLength + nextChunk.byteLength,
        truncated: chunk.byteLength > remaining,
      };
    },
  ).pipe(
    Effect.map((state) => {
      const bytes = Buffer.concat(state.chunks, state.byteLength);
      return {
        text: (state.truncated ? trimIncompleteUtf8Suffix(bytes) : bytes).toString("utf8"),
        truncated: state.truncated,
      };
    }),
  );
}

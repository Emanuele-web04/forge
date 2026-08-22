import { describe, expect, it } from "vitest";

import { encodeVoiceRecordingWav } from "./voiceRecorderEncoding";

describe("encodeVoiceRecordingWav", () => {
  it.each([48_000, 44_100, 24_000, 16_000])(
    "matches the legacy encoder across chunk boundaries at %i Hz",
    (inputSampleRateHz) => {
      const samples = Float32Array.from(
        { length: 10_003 },
        (_, index) => Math.sin((index * Math.PI * 2) / 97) * 0.8,
      );
      const chunks = [samples.slice(0, 1), samples.slice(1, 4_098), samples.slice(4_098)];

      const encoded = encodeVoiceRecordingWav(chunks, inputSampleRateHz, 24_000);

      expect(encoded).not.toBeNull();
      expect(new Uint8Array(encoded?.bytes ?? new ArrayBuffer(0))).toEqual(
        new Uint8Array(legacyEncode(chunks, inputSampleRateHz, 24_000)),
      );
    },
  );

  it("returns normalized duration and WAV metadata", () => {
    const encoded = encodeVoiceRecordingWav([new Float32Array(48_000)], 48_000, 24_000);
    const view = new DataView(encoded?.bytes ?? new ArrayBuffer(0));

    expect(encoded).toMatchObject({ durationMs: 1_000, sampleCount: 24_000 });
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(48_000);
  });

  it("rejects empty audio and invalid sample rates", () => {
    expect(encodeVoiceRecordingWav([], 48_000, 24_000)).toBeNull();
    expect(encodeVoiceRecordingWav([new Float32Array([0.5])], 0, 24_000)).toBeNull();
    expect(encodeVoiceRecordingWav([new Float32Array([0.5])], 48_000, Number.NaN)).toBeNull();
  });
});

function legacyEncode(
  chunks: readonly Float32Array[],
  inputSampleRateHz: number,
  outputSampleRateHz: number,
): ArrayBuffer {
  const merged = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const ratio = inputSampleRateHz / outputSampleRateHz;
  const outputLength = Math.max(1, Math.round(merged.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(merged.length - 1, leftIndex + 1);
    const leftValue = merged[leftIndex] ?? 0;
    const rightValue = merged[rightIndex] ?? leftValue;
    output[index] = leftValue + (rightValue - leftValue) * (sourceIndex - leftIndex);
  }

  const view = new DataView(new ArrayBuffer(44 + output.length * 2));
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + output.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRateHz, true);
  view.setUint32(28, outputSampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, output.length * 2, true);
  let wavOffset = 44;
  for (const sample of output) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(wavOffset, Math.round(pcm), true);
    wavOffset += 2;
  }
  return view.buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

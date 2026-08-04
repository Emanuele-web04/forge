// Reproducible Mic post-processing benchmark. Run with:
// bun apps/web/scripts/voice-processing-benchmark.ts

import { encodeVoiceRecordingWav } from "../src/lib/voiceRecorderEncoding";

const TARGET_SAMPLE_RATE = 24_000;
const LEGACY_INPUT_SAMPLE_RATE = 48_000;
const WARMUP_COUNT = 5;
const SAMPLE_COUNT = 25;

interface BenchmarkStats {
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly stddevMs: number;
}

function makeChunks(
  durationSeconds: number,
  inputSampleRateHz: number,
  chunkSize: number,
): Float32Array[] {
  const total = durationSeconds * inputSampleRateHz;
  const chunks: Float32Array[] = [];
  for (let offset = 0; offset < total; offset += chunkSize) {
    const length = Math.min(chunkSize, total - offset);
    const chunk = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      chunk[index] = Math.sin(((offset + index) * Math.PI * 2 * 220) / inputSampleRateHz) * 0.5;
    }
    chunks.push(chunk);
  }
  return chunks;
}

function legacyEncode(chunks: readonly Float32Array[], inputSampleRateHz: number): ArrayBuffer {
  return legacyEncodeWav(
    legacyResample(legacyMerge(chunks), inputSampleRateHz, TARGET_SAMPLE_RATE),
  );
}

function legacyMerge(chunks: readonly Float32Array[]): Float32Array {
  const inputSampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(inputSampleCount);
  let mergedOffset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, mergedOffset);
    mergedOffset += chunk.length;
  }
  return merged;
}

function legacyResample(
  samples: Float32Array,
  inputSampleRateHz: number,
  outputSampleRateHz: number,
): Float32Array {
  if (inputSampleRateHz === outputSampleRateHz) return samples.slice();
  const ratio = inputSampleRateHz / outputSampleRateHz;
  const resampled = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let index = 0; index < resampled.length; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const leftValue = samples[leftIndex] ?? 0;
    const rightValue = samples[rightIndex] ?? leftValue;
    resampled[index] = leftValue + (rightValue - leftValue) * (sourceIndex - leftIndex);
  }
  return resampled;
}

function legacyEncodeWav(samples: Float32Array): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  writeWavHeader(view, samples.length);
  let wavOffset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(wavOffset, Math.round(pcm), true);
    wavOffset += 2;
  }
  return view.buffer;
}

function writeWavHeader(view: DataView, sampleCount: number): void {
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function summarize(values: readonly number[]): BenchmarkStats {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return {
    meanMs: mean,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    stddevMs: Math.sqrt(variance),
  };
}

function percentile(sorted: readonly number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

function measure(
  implementation: string,
  durationSeconds: number,
  inputSampleRateHz: number,
  chunkSize: number,
  run: (chunks: readonly Float32Array[]) => ArrayBuffer,
  temporaryBytes: number,
): void {
  const chunks = makeChunks(durationSeconds, inputSampleRateHz, chunkSize);
  let checksum = 0;
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    checksum ^= run(chunks).byteLength;
  }
  const durations: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    Bun.gc(true);
    const startedAt = performance.now();
    checksum ^= run(chunks).byteLength;
    durations.push(performance.now() - startedAt);
  }
  const capturedChunkBytes = durationSeconds * inputSampleRateHz * 4;
  console.log(
    JSON.stringify({
      implementation,
      durationSeconds,
      inputSampleRateHz,
      targetSampleRateHz: TARGET_SAMPLE_RATE,
      warmups: WARMUP_COUNT,
      samples: SAMPLE_COUNT,
      temporaryBytes,
      capturedChunkBytes,
      totalAudioArrayBytes: capturedChunkBytes + temporaryBytes,
      ...summarize(durations),
      checksum,
    }),
  );
}

for (const durationSeconds of [30, 120]) {
  const outputBytes = 44 + durationSeconds * TARGET_SAMPLE_RATE * 2;
  const legacyInputSamples = durationSeconds * LEGACY_INPUT_SAMPLE_RATE;
  const legacyResampledBytes = durationSeconds * TARGET_SAMPLE_RATE * 4;
  measure(
    "legacy-48khz",
    durationSeconds,
    LEGACY_INPUT_SAMPLE_RATE,
    4_096,
    (chunks) => legacyEncode(chunks, LEGACY_INPUT_SAMPLE_RATE),
    legacyInputSamples * 4 + legacyResampledBytes + outputBytes,
  );
  measure(
    "optimized-fallback-48khz",
    durationSeconds,
    LEGACY_INPUT_SAMPLE_RATE,
    4_096,
    (chunks) =>
      encodeVoiceRecordingWav(chunks, LEGACY_INPUT_SAMPLE_RATE, TARGET_SAMPLE_RATE)?.bytes ??
      new ArrayBuffer(0),
    outputBytes,
  );
  measure(
    "optimized-target-24khz",
    durationSeconds,
    TARGET_SAMPLE_RATE,
    2_048,
    (chunks) =>
      encodeVoiceRecordingWav(chunks, TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE)?.bytes ??
      new ArrayBuffer(0),
    outputBytes,
  );
}

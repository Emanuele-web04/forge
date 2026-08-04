// FILE: voiceRecorderEncoding.ts
// Purpose: Converts chunked browser microphone samples directly into normalized mono WAV bytes.
// Layer: Client audio utility
// Exports: encodeVoiceRecordingWav

export interface EncodedVoiceRecordingWav {
  readonly bytes: ArrayBuffer;
  readonly durationMs: number;
  readonly sampleCount: number;
}

const IS_LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

export function encodeVoiceRecordingWav(
  chunks: readonly Float32Array[],
  inputSampleRateHz: number,
  outputSampleRateHz: number,
): EncodedVoiceRecordingWav | null {
  if (
    !Number.isFinite(inputSampleRateHz) ||
    inputSampleRateHz <= 0 ||
    !Number.isFinite(outputSampleRateHz) ||
    outputSampleRateHz <= 0
  ) {
    return null;
  }

  let inputSampleCount = 0;
  for (const chunk of chunks) {
    inputSampleCount += chunk.length;
  }
  if (inputSampleCount === 0) {
    return null;
  }

  const inputSamplesPerOutputSample = inputSampleRateHz / outputSampleRateHz;
  const outputSampleCount = Math.max(1, Math.round(inputSampleCount / inputSamplesPerOutputSample));
  const dataView = new DataView(new ArrayBuffer(44 + outputSampleCount * 2));
  writeWavHeader(dataView, outputSampleCount, outputSampleRateHz);
  const pcmSamples = IS_LITTLE_ENDIAN
    ? new Int16Array(dataView.buffer, 44, outputSampleCount)
    : null;

  let wavOffset = 44;
  let outputIndex = 0;
  if (inputSampleRateHz === outputSampleRateHz) {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (!chunk) continue;
      for (let sampleIndex = 0; sampleIndex < chunk.length; sampleIndex += 1) {
        const sample = chunk[sampleIndex] ?? 0;
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        if (pcmSamples) {
          pcmSamples[outputIndex] = Math.round(pcm);
        } else {
          dataView.setInt16(wavOffset, Math.round(pcm), true);
        }
        outputIndex += 1;
        wavOffset += 2;
      }
    }
  } else {
    let chunkIndex = 0;
    let chunkStart = 0;
    let chunk = chunks[0];
    const integerStride = Number.isInteger(inputSamplesPerOutputSample);
    for (let index = 0; index < outputSampleCount; index += 1) {
      const sourceIndex = index * inputSamplesPerOutputSample;
      const leftIndex = Math.floor(sourceIndex);
      while (chunk && leftIndex >= chunkStart + chunk.length && chunkIndex < chunks.length - 1) {
        chunkStart += chunk.length;
        chunkIndex += 1;
        chunk = chunks[chunkIndex];
      }
      const localIndex = leftIndex - chunkStart;
      const leftValue = chunk?.[localIndex] ?? 0;
      let sample = leftValue;
      if (!integerStride) {
        const rightValue =
          leftIndex >= inputSampleCount - 1
            ? leftValue
            : (chunk?.[localIndex + 1] ?? chunks[chunkIndex + 1]?.[0] ?? leftValue);
        // The legacy pipeline materialized interpolation into Float32Array before
        // PCM conversion. Preserve that rounding so clips stay byte-for-byte identical.
        sample = Math.fround(leftValue + (rightValue - leftValue) * (sourceIndex - leftIndex));
      }
      const clamped = Math.max(-1, Math.min(1, sample));
      const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (pcmSamples) {
        pcmSamples[index] = Math.round(pcm);
      } else {
        dataView.setInt16(wavOffset, Math.round(pcm), true);
      }
      wavOffset += 2;
    }
  }

  return {
    bytes: dataView.buffer,
    durationMs: Math.max(1, Math.round((outputSampleCount / outputSampleRateHz) * 1_000)),
    sampleCount: outputSampleCount,
  };
}

function writeWavHeader(view: DataView, sampleCount: number, sampleRateHz: number): void {
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
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

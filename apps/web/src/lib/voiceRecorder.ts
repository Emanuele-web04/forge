// FILE: voiceRecorder.ts
// Purpose: Captures microphone audio in the browser and normalizes it to Remodex-style WAV clips.
// Layer: Client utility hook
// Exports: useVoiceRecorder, formatVoiceRecordingDuration, isVoiceRecordingCancelledError
// Depends on: browser media devices, Web Audio API, the streaming WAV encoder, and FileReader.

import { useCallback, useEffect, useRef, useState } from "react";

import { encodeVoiceRecordingWav } from "./voiceRecorderEncoding";

const TARGET_SAMPLE_RATE = 24_000;
const BUFFER_SIZE = 2_048;

export interface VoiceRecordingPayload {
  readonly audioBase64: string;
  readonly mimeType: "audio/wav";
  readonly sampleRateHz: number;
  readonly durationMs: number;
}

interface RecorderRuntime {
  readonly audioContext: AudioContext;
  readonly sourceNode: MediaStreamAudioSourceNode;
  readonly processorNode: ScriptProcessorNode;
  readonly silentGainNode: GainNode;
  readonly stream: MediaStream;
  readonly chunks: Float32Array[];
  readonly startedAt: number;
  sampleRateHz: number;
}

const MAX_WAVEFORM_SAMPLES = 160;

class VoiceRecordingCancelledError extends Error {
  override readonly name = "VoiceRecordingCancelledError";
}

export function isVoiceRecordingCancelledError(error: unknown): boolean {
  return error instanceof VoiceRecordingCancelledError;
}

export function formatVoiceRecordingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function useVoiceRecorder() {
  const runtimeRef = useRef<RecorderRuntime | null>(null);
  const startGenerationRef = useRef(0);
  const isStartingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const waveformLevelsRef = useRef<number[]>([]);
  const waveformLastEmitAtRef = useRef(0);
  const [isRecording, setIsRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [waveformLevels, setWaveformLevels] = useState<number[]>([]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const teardownRuntime = useCallback(async () => {
    startGenerationRef.current += 1;
    isStartingRef.current = false;
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    clearTimer();
    setIsRecording(false);

    if (!runtime) {
      setDurationMs(0);
      return null;
    }

    runtime.processorNode.onaudioprocess = null;
    runtime.sourceNode.disconnect();
    runtime.processorNode.disconnect();
    runtime.silentGainNode.disconnect();
    runtime.stream.getTracks().forEach((track) => track.stop());
    await runtime.audioContext.close().catch(() => undefined);

    const sampleRateHz = runtime.sampleRateHz;
    const duration = Math.max(0, performance.now() - runtime.startedAt);
    setDurationMs(0);

    return {
      chunks: runtime.chunks,
      sampleRateHz,
      durationMs: duration,
    };
  }, [clearTimer]);

  const startRecording = useCallback(async () => {
    if (runtimeRef.current || isStartingRef.current) {
      throw new Error("Voice recording is already running.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone recording is unavailable in this browser.");
    }

    const startGeneration = startGenerationRef.current + 1;
    startGenerationRef.current = startGeneration;
    isStartingRef.current = true;
    const assertStartIsCurrent = () => {
      if (startGenerationRef.current !== startGeneration) {
        throw new VoiceRecordingCancelledError("Voice recording was cancelled.");
      }
    };

    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let processorNode: ScriptProcessorNode | null = null;
    let silentGainNode: GainNode | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: { ideal: TARGET_SAMPLE_RATE },
        },
      });
      assertStartIsCurrent();
      audioContext = createVoiceAudioContext();
      await audioContext.resume();
      assertStartIsCurrent();

      sourceNode = audioContext.createMediaStreamSource(stream);
      processorNode = audioContext.createScriptProcessor(
        resolveVoiceProcessorBufferSize(audioContext.sampleRate),
        1,
        1,
      );
      silentGainNode = audioContext.createGain();
      silentGainNode.gain.value = 0;

      const runtime: RecorderRuntime = {
        audioContext,
        sourceNode,
        processorNode,
        silentGainNode,
        stream,
        chunks: [],
        startedAt: performance.now(),
        sampleRateHz: audioContext.sampleRate,
      };

      processorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        const channelCount = inputBuffer.numberOfChannels;
        const frameCount = inputBuffer.length;
        const monoSamples = new Float32Array(frameCount);

        let sumOfSquares = 0;
        if (channelCount === 1) {
          const channelData = inputBuffer.getChannelData(0);
          for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
            const sample = channelData[sampleIndex] ?? 0;
            monoSamples[sampleIndex] = sample;
            sumOfSquares += sample * sample;
          }
        } else {
          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelData = inputBuffer.getChannelData(channelIndex);
            for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
              monoSamples[sampleIndex] =
                (monoSamples[sampleIndex] ?? 0) + (channelData[sampleIndex] ?? 0);
            }
          }
          const normalizer = channelCount > 0 ? channelCount : 1;
          for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
            const sample = (monoSamples[sampleIndex] ?? 0) / normalizer;
            monoSamples[sampleIndex] = sample;
            sumOfSquares += sample * sample;
          }
        }

        runtime.chunks.push(monoSamples);

        const rmsLevel = Math.min(
          1,
          Math.sqrt(sumOfSquares / Math.max(1, monoSamples.length)) * 3.2,
        );
        const now = performance.now();
        if (now - waveformLastEmitAtRef.current >= 45) {
          waveformLastEmitAtRef.current = now;
          const nextLevels = [...waveformLevelsRef.current, rmsLevel].slice(-MAX_WAVEFORM_SAMPLES);
          waveformLevelsRef.current = nextLevels;
          setWaveformLevels(nextLevels);
        }
      };

      sourceNode.connect(processorNode);
      processorNode.connect(silentGainNode);
      silentGainNode.connect(audioContext.destination);

      // Publish the runtime only while this startup still owns the current
      // generation. This keeps future async setup additions cancellation-safe.
      assertStartIsCurrent();
      runtimeRef.current = runtime;
      isStartingRef.current = false;
      waveformLevelsRef.current = [];
      waveformLastEmitAtRef.current = 0;
      setWaveformLevels([]);
      setDurationMs(0);
      setIsRecording(true);
      timerRef.current = window.setInterval(() => {
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime) {
          return;
        }
        setDurationMs(Math.max(0, performance.now() - activeRuntime.startedAt));
      }, 200);
    } catch (error) {
      processorNode?.disconnect();
      sourceNode?.disconnect();
      silentGainNode?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      await audioContext?.close().catch(() => undefined);
      if (startGenerationRef.current === startGeneration) {
        isStartingRef.current = false;
      }
      throw error;
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<VoiceRecordingPayload | null> => {
    const recorded = await teardownRuntime();
    if (!recorded) {
      return null;
    }

    const encoded = encodeVoiceRecordingWav(
      recorded.chunks,
      recorded.sampleRateHz,
      TARGET_SAMPLE_RATE,
    );
    if (!encoded) {
      return null;
    }

    const audioBase64 = await blobToBase64(new Blob([encoded.bytes], { type: "audio/wav" }));

    const payload: VoiceRecordingPayload = {
      audioBase64,
      mimeType: "audio/wav",
      sampleRateHz: TARGET_SAMPLE_RATE,
      durationMs: encoded.durationMs || recorded.durationMs,
    };
    return payload;
  }, [teardownRuntime]);

  const cancelRecording = useCallback(async () => {
    await teardownRuntime();
    waveformLevelsRef.current = [];
    waveformLastEmitAtRef.current = 0;
    setWaveformLevels([]);
  }, [teardownRuntime]);

  useEffect(
    () => () => {
      void teardownRuntime();
    },
    [teardownRuntime],
  );

  return {
    isRecording,
    durationMs,
    waveformLevels,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}

function createVoiceAudioContext(): AudioContext {
  try {
    return new AudioContext({ latencyHint: "interactive", sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    return new AudioContext({ latencyHint: "interactive" });
  }
}

function resolveVoiceProcessorBufferSize(sampleRateHz: number): number {
  return sampleRateHz > TARGET_SAMPLE_RATE * 1.5 ? BUFFER_SIZE * 2 : BUFFER_SIZE;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read recorded audio."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read recorded audio."));
    });
    reader.readAsDataURL(blob);
  });
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

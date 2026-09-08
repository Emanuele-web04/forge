// FILE: groqVoiceTranscription.ts
// Purpose: Owns the Groq speech-to-text origin, multipart, and resource policy.
// Layer: Shared Node/Electron provider transport

import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";

import { encodeOutboundMultipart, outboundHttp, type OutboundHttpResponse } from "./outboundHttp";

export const GROQ_VOICE_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const MAX_MULTIPART_BYTES = SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const GROQ_VOICE_ORIGIN = new URL(GROQ_VOICE_TRANSCRIPTION_URL).origin;

export function readGroqApiKeyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = env.GROQ_API_KEY?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export async function prewarmGroqVoiceTranscriptionConnection(): Promise<void> {
  await outboundHttp.request({
    policy: {
      service: "groq-voice-transcription",
      allowedOrigins: [GROQ_VOICE_ORIGIN],
      timeoutMs: 10_000,
      maxRequestBytes: 1,
      maxResponseBytes: 64 * 1024,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: true,
    },
    url: new URL("/", GROQ_VOICE_TRANSCRIPTION_URL),
    method: "HEAD",
  });
}

export function requestGroqVoiceTranscription(input: {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly apiKey: string;
  readonly model: string;
  readonly signal?: AbortSignal;
}): Promise<OutboundHttpResponse> {
  const multipart = encodeOutboundMultipart(
    [
      {
        name: "file",
        filename: "voice.wav",
        contentType: input.mimeType,
        body: input.audio,
      },
      {
        name: "model",
        body: input.model,
      },
      {
        name: "response_format",
        body: "json",
      },
    ],
    { maxBytes: MAX_MULTIPART_BYTES },
  );

  return outboundHttp.request({
    policy: {
      service: "groq-voice-transcription",
      allowedOrigins: [GROQ_VOICE_ORIGIN],
      timeoutMs: 30_000,
      maxRequestBytes: MAX_MULTIPART_BYTES,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: true,
    },
    url: GROQ_VOICE_TRANSCRIPTION_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": multipart.contentType,
    },
    body: multipart.body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

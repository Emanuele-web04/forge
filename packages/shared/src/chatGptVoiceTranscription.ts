// FILE: chatGptVoiceTranscription.ts
// Purpose: Owns the exact ChatGPT voice-upload origin, multipart, and resource policy.
// Layer: Shared Node/Electron provider transport

import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";

import { encodeOutboundMultipart, outboundHttp, type OutboundHttpResponse } from "./outboundHttp";

export const CHATGPT_VOICE_TRANSCRIPTION_URL = "https://chatgpt.com/backend-api/transcribe";

const MAX_MULTIPART_BYTES = SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_VOICE_UPLOAD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const VOICE_UPLOAD_USER_AGENT = resolveVoiceUploadUserAgent();

function resolveVoiceUploadUserAgent(): string {
  const override = process.env.SYNARA_VOICE_UPLOAD_USER_AGENT?.trim();
  return override && !/[\r\n]/u.test(override) ? override : DEFAULT_VOICE_UPLOAD_USER_AGENT;
}

export async function prewarmChatGptVoiceTranscriptionConnection(): Promise<void> {
  await outboundHttp.request({
    policy: {
      service: "chatgpt-voice-transcription",
      allowedOrigins: [new URL(CHATGPT_VOICE_TRANSCRIPTION_URL).origin],
      timeoutMs: 10_000,
      maxRequestBytes: 1,
      maxResponseBytes: 64 * 1024,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: true,
    },
    url: new URL("/", CHATGPT_VOICE_TRANSCRIPTION_URL),
    method: "HEAD",
    headers: { "User-Agent": VOICE_UPLOAD_USER_AGENT },
  });
}

export function requestChatGptVoiceTranscription(input: {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl?: string;
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
    ],
    { maxBytes: MAX_MULTIPART_BYTES },
  );

  return outboundHttp.request({
    policy: {
      service: "chatgpt-voice-transcription",
      allowedOrigins: [new URL(CHATGPT_VOICE_TRANSCRIPTION_URL).origin],
      timeoutMs: 30_000,
      maxRequestBytes: MAX_MULTIPART_BYTES,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: true,
    },
    url: input.transcriptionUrl?.trim() || CHATGPT_VOICE_TRANSCRIPTION_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": multipart.contentType,
      "User-Agent": VOICE_UPLOAD_USER_AGENT,
    },
    body: multipart.body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

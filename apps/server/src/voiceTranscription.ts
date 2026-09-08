// FILE: voiceTranscription.ts
// Purpose: Validates Remodex-style WAV payloads and proxies them to the selected STT backend.
// Layer: Server utility
// Exports: transcribeVoiceWithChatGptSession, transcribeVoiceWithGroq
// Depends on: ChatGPT session auth supplied by Codex app-server callers, or a Groq API key.

import { Buffer } from "node:buffer";

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";
import { requestChatGptVoiceTranscription } from "@synara/shared/chatGptVoiceTranscription";
import { requestGroqVoiceTranscription } from "@synara/shared/groqVoiceTranscription";
import { decodeOutboundJson, type OutboundHttpResponse } from "@synara/shared/outboundHttp";

const MAX_DURATION_MS = 120_000;

export interface ChatGptVoiceAuthContext {
  readonly token: string;
  readonly transcriptionUrl?: string;
}

// Validate the captured WAV clip and retry once if the ChatGPT session needs a refresh.
export async function transcribeVoiceWithChatGptSession(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly resolveAuth: (refreshToken: boolean) => Promise<ChatGptVoiceAuthContext>;
  readonly signal?: AbortSignal;
}): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeVoiceAudio(input.request);
  let auth = await input.resolveAuth(false);
  let response = await requestTranscription({
    audioBuffer,
    mimeType: input.request.mimeType,
    token: auth.token,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    auth = await input.resolveAuth(true);
    response = await requestTranscription({
      audioBuffer,
      mimeType: input.request.mimeType,
      token: auth.token,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
    });
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(readTranscriptionErrorMessage(response));
  }

  let payload: { text?: unknown; transcript?: unknown } | null = null;
  try {
    payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      text?: unknown;
      transcript?: unknown;
    };
  } catch {
    payload = null;
  }
  const text = readString(payload?.text) ?? readString(payload?.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

export async function transcribeVoiceWithGroq(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly apiKey: string;
  readonly model: string;
  readonly signal?: AbortSignal;
}): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeVoiceAudio(input.request);
  const response = await requestGroqVoiceTranscription({
    audio: audioBuffer,
    mimeType: input.request.mimeType,
    apiKey: input.apiKey,
    model: input.model,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(readGroqTranscriptionErrorMessage(response));
  }

  let payload: { text?: unknown; transcript?: unknown } | null = null;
  try {
    payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      text?: unknown;
      transcript?: unknown;
    };
  } catch {
    payload = null;
  }
  const text = readString(payload?.text) ?? readString(payload?.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

// Keep the server-side contract strict so the private backend only sees normalized clips.
function decodeVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = normalizeBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
}

async function requestTranscription(input: {
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<OutboundHttpResponse> {
  return requestChatGptVoiceTranscription({
    audio: input.audioBuffer,
    mimeType: input.mimeType,
    token: input.token,
    ...(input.transcriptionUrl ? { transcriptionUrl: input.transcriptionUrl } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function readTranscriptionErrorMessage(response: OutboundHttpResponse): string {
  let errorMessage = `Transcription failed with status ${response.status}.`;
  try {
    const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      error?: { message?: unknown };
      message?: unknown;
    } | null;
    const providerMessage =
      readString(payload?.error?.message) ?? readString(payload?.message) ?? null;
    if (providerMessage) {
      errorMessage = providerMessage;
    }
  } catch {
    // Keep the generic status-based message when the provider body is empty or invalid.
  }

  if (response.status === 401 || response.status === 403) {
    return "Your ChatGPT login has expired. Sign in again.";
  }

  return errorMessage;
}

function readGroqTranscriptionErrorMessage(response: OutboundHttpResponse): string {
  let errorMessage = `Transcription failed with status ${response.status}.`;
  try {
    const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      error?: { message?: unknown };
      message?: unknown;
    } | null;
    const providerMessage =
      readString(payload?.error?.message) ?? readString(payload?.message) ?? null;
    if (providerMessage) {
      errorMessage = providerMessage;
    }
  } catch {
    // Keep the generic status-based message when the provider body is empty or invalid.
  }

  if (response.status === 401 || response.status === 403) {
    return "The Groq API key is invalid. Update it in Settings > General.";
  }
  if (response.status === 429) {
    return "Groq rate-limited the transcription request. Try again in a moment.";
  }

  return errorMessage;
}

function normalizeBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function readString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

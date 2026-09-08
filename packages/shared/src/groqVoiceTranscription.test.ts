// FILE: groqVoiceTranscription.test.ts
// Purpose: Verifies Groq STT transport origin pinning and multipart fields.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GROQ_VOICE_TRANSCRIPTION_URL,
  prewarmGroqVoiceTranscriptionConnection,
  readGroqApiKeyFromEnv,
  requestGroqVoiceTranscription,
} from "./groqVoiceTranscription";
import { outboundHttp } from "./outboundHttp";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readGroqApiKeyFromEnv", () => {
  it("returns a trimmed key and ignores blanks", () => {
    expect(readGroqApiKeyFromEnv({ GROQ_API_KEY: "  gsk_test  " })).toBe("gsk_test");
    expect(readGroqApiKeyFromEnv({ GROQ_API_KEY: "   " })).toBeNull();
    expect(readGroqApiKeyFromEnv({})).toBeNull();
  });
});

describe("prewarmGroqVoiceTranscriptionConnection", () => {
  it("opens the Groq HTTPS origin with a bounded HEAD request", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new Uint8Array(),
      url: "https://api.groq.com/",
    });

    await prewarmGroqVoiceTranscriptionConnection();

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL("/", GROQ_VOICE_TRANSCRIPTION_URL),
        method: "HEAD",
        policy: expect.objectContaining({
          service: "groq-voice-transcription",
          timeoutMs: 10_000,
          maxResponseBytes: 64 * 1024,
          maxConcurrent: 2,
        }),
      }),
    );
  });
});

describe("requestGroqVoiceTranscription", () => {
  it("posts WAV audio and the selected model to Groq transcriptions", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new Uint8Array(),
      url: GROQ_VOICE_TRANSCRIPTION_URL,
    });

    await requestGroqVoiceTranscription({
      audio: Uint8Array.from([1, 2, 3]),
      mimeType: "audio/wav",
      apiKey: "gsk_test",
      model: "whisper-large-v3-turbo",
    });

    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.url).toBe(GROQ_VOICE_TRANSCRIPTION_URL);
    expect(outbound?.method).toBe("POST");
    expect(outbound?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer gsk_test",
      }),
    );
    const body = new TextDecoder().decode(outbound?.body as Uint8Array);
    expect(body).toContain('filename="voice.wav"');
    expect(body).toContain('name="model"');
    expect(body).toContain("whisper-large-v3-turbo");
    expect(body).toContain('name="response_format"');
    expect(body).toContain("json");
  });
});

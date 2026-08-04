// FILE: chatGptVoiceTranscription.test.ts
// Purpose: Verifies the voice transport warms the provider connection safely.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHATGPT_VOICE_TRANSCRIPTION_URL,
  prewarmChatGptVoiceTranscriptionConnection,
  requestChatGptVoiceTranscription,
} from "./chatGptVoiceTranscription";
import { outboundHttp } from "./outboundHttp";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prewarmChatGptVoiceTranscriptionConnection", () => {
  it("opens the ChatGPT HTTPS origin with a bounded HEAD request", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new Uint8Array(),
      url: "https://chatgpt.com/",
    });

    await prewarmChatGptVoiceTranscriptionConnection();

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL("/", CHATGPT_VOICE_TRANSCRIPTION_URL),
        method: "HEAD",
        headers: {
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
        },
        policy: expect.objectContaining({
          service: "chatgpt-voice-transcription",
          timeoutMs: 10_000,
          maxResponseBytes: 64 * 1024,
          maxConcurrent: 2,
        }),
      }),
    );
  });

  it("uses the accepted browser identity for transcription uploads", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new Uint8Array(),
      url: CHATGPT_VOICE_TRANSCRIPTION_URL,
    });

    await requestChatGptVoiceTranscription({
      audio: Uint8Array.from([1, 2, 3]),
      mimeType: "audio/wav",
      token: "test-token",
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
        }),
      }),
    );
  });
});

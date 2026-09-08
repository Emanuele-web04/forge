// FILE: voiceTranscription.test.ts
// Purpose: Verifies ChatGPT-session voice transcription behavior without contacting OpenAI.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceTranscription utility and mocked fetch responses.

import type { ServerVoiceTranscriptionInput } from "@synara/contracts";
import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { transcribeVoiceWithChatGptSession, transcribeVoiceWithGroq } from "./voiceTranscription";

const WAV_BASE64 = Buffer.from("RIFF0000WAVE", "ascii").toString("base64");

const baseRequest: ServerVoiceTranscriptionInput = {
  provider: "codex",
  cwd: "/tmp/project",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1_000,
  audioBase64: WAV_BASE64,
};

function outboundJson(body: unknown, status = 200): OutboundHttpResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: "https://chatgpt.com/backend-api/transcribe",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transcribeVoiceWithChatGptSession", () => {
  it("uses the ChatGPT transcription backend", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValue(outboundJson({ text: "hello" }));

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: "chatgpt-token" }),
    });

    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.url).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(new TextDecoder().decode(outbound?.body as Uint8Array)).not.toContain('name="model"');
  });

  it("refreshes the ChatGPT session once when the upload is unauthorized", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValueOnce(outboundJson({}, 401))
      .mockResolvedValueOnce(outboundJson({ text: "hello" }));
    const resolveAuth = vi.fn(async (refreshToken: boolean) => ({
      token: refreshToken ? "fresh-chatgpt-token" : "stale-chatgpt-token",
    }));

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth,
    });

    expect(resolveAuth).toHaveBeenNthCalledWith(1, false);
    expect(resolveAuth).toHaveBeenNthCalledWith(2, true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a provider-returned transcription origin before forwarding the token", async () => {
    await expect(
      transcribeVoiceWithChatGptSession({
        request: baseRequest,
        resolveAuth: async () => ({
          token: "chatgpt-token",
          transcriptionUrl: "https://attacker.example/transcribe",
        }),
      }),
    ).rejects.toThrow(/not allowed/u);
  });
});

describe("transcribeVoiceWithGroq", () => {
  it("uploads the WAV clip to Groq with the selected model", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValue(outboundJson({ text: "hello from groq" }, 200));

    const result = await transcribeVoiceWithGroq({
      request: baseRequest,
      apiKey: "gsk_test",
      model: "whisper-large-v3-turbo",
    });

    expect(result).toEqual({ text: "hello from groq" });
    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(outbound?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer gsk_test" }),
    );
    const body = new TextDecoder().decode(outbound?.body as Uint8Array);
    expect(body).toContain("whisper-large-v3-turbo");
  });

  it("maps Groq auth failures to a settings-facing API key error", async () => {
    vi.spyOn(outboundHttp, "request").mockResolvedValue(outboundJson({}, 401));

    await expect(
      transcribeVoiceWithGroq({
        request: baseRequest,
        apiKey: "gsk_bad",
        model: "whisper-large-v3-turbo",
      }),
    ).rejects.toThrow("The Groq API key is invalid. Update it in Settings > General.");
  });
});

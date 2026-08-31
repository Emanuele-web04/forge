// FILE: voiceTranscription.test.ts
// Purpose: Verifies ChatGPT-session voice transcription behavior without contacting OpenAI.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceTranscription utility and mocked fetch responses.

import type { ServerVoiceTranscriptionInput } from "@synara/contracts";
import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { transcribeVoiceWithChatGptSession } from "./voiceTranscription";

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

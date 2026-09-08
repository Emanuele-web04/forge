// FILE: voiceTranscriptionDispatch.test.ts
// Purpose: Verifies STT routing uses Groq independently of the coding-agent harness.

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";

import { ServerSettingsService } from "./serverSettings";
import { transcribeConfiguredVoice } from "./voiceTranscriptionDispatch";

const WAV_BYTES = Buffer.from("RIFF0000WAVE", "ascii");

function outboundJson(body: unknown, status = 200): OutboundHttpResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("transcribeConfiguredVoice", () => {
  it("uses Groq even when Codex is disabled", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_test");
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValue(outboundJson({ text: "independent groq" }));
    const transcribeVoice = vi.fn(() => Effect.succeed({ text: "codex should not run" }));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        return yield* transcribeConfiguredVoice(
          {
            provider: "codex",
            cwd: "/tmp/project",
            mimeType: "audio/wav",
            sampleRateHz: 24_000,
            durationMs: 1_000,
            audioBase64: WAV_BYTES.toString("base64"),
          },
          serverSettings,
          {
            getByProvider: () => Effect.succeed({ provider: "codex", transcribeVoice } as never),
            listProviders: () => Effect.succeed(["codex"]),
          },
        );
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            voiceTranscription: { provider: "auto" },
            providers: { codex: { enabled: false } },
          }),
        ),
      ),
    );

    expect(result).toEqual({ text: "independent groq" });
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Groq is selected without an API key", async () => {
    const transcribeVoice = vi.fn(() => Effect.succeed({ text: "codex should not run" }));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettingsService;
          return yield* transcribeConfiguredVoice(
            {
              provider: "codex",
              cwd: "/tmp/project",
              mimeType: "audio/wav",
              sampleRateHz: 24_000,
              durationMs: 1_000,
              audioBase64: WAV_BYTES.toString("base64"),
            },
            serverSettings,
            {
              getByProvider: () => Effect.succeed({ provider: "codex", transcribeVoice } as never),
              listProviders: () => Effect.succeed(["codex"]),
            },
          );
        }).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              voiceTranscription: { provider: "groq" },
            }),
          ),
        ),
      ),
    ).rejects.toThrow("Add a Groq API key in Settings > General, or set GROQ_API_KEY.");

    expect(transcribeVoice).not.toHaveBeenCalled();
  });
});

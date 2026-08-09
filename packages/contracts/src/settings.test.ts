import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";

import { ServerSettingsPatch } from "./settings";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettingsPatch options bounds", () => {
  it("rejects options nested deeper than the depth bound", () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 22; i++) {
      deep = { child: deep };
    }

    expect(() =>
      decodePatch({
        textGenerationModelSelection: {
          provider: "codex",
          options: deep,
        },
      }),
    ).toThrow();
  });

  it("rejects options larger than the serialized byte bound", () => {
    expect(() =>
      decodePatch({
        textGenerationModelSelection: {
          provider: "codex",
          options: { padding: "x".repeat(300_000) },
        },
      }),
    ).toThrow();
  });

  it("rejects null options before provider-specific settings normalization", () => {
    expect(() =>
      decodePatch({
        textGenerationModelSelection: {
          provider: "codex",
          model: "gpt-5.6-luna",
          options: null,
        },
      }),
    ).toThrow();
  });

  it("round-trips valid nested options", () => {
    const patch: ServerSettingsPatch = {
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { reasoningEffort: "high", tags: ["a", "b"] },
      },
    };

    expect(decodePatch(patch)).toEqual(patch);
  });
});

describe("ServerSettingsPatch options over the JSON RPC codec", () => {
  it("survives the wire codec as an object, not null", async () => {
    const patch: ServerSettingsPatch = {
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { reasoningEffort: "high", tags: ["a", "b"] },
      },
    };

    // The same codec the RPC client uses to serialize request payloads.
    const codec = Schema.toCodecJson(ServerSettingsPatch);
    const encodedRaw = await Effect.runPromise(Schema.encodeUnknownEffect(codec)(patch));

    // The bug this locks in: the former Schema.Unknown options field encoded as
    // null on the wire, silently dropping every option override.
    const encoded = encodedRaw as unknown as {
      textGenerationModelSelection?: { options?: unknown };
    };
    expect(encoded.textGenerationModelSelection?.options).toEqual({
      reasoningEffort: "high",
      tags: ["a", "b"],
    });

    const decoded = decodePatch(encodedRaw);
    expect(decoded).toEqual(patch);
  });

  it("round-trips an options-only patch through the wire codec", async () => {
    const patch: ServerSettingsPatch = {
      textGenerationModelSelection: {
        options: { reasoningEffort: "high" },
      },
    };

    const codec = Schema.toCodecJson(ServerSettingsPatch);
    const encodedRaw = await Effect.runPromise(Schema.encodeUnknownEffect(codec)(patch));

    const encoded = encodedRaw as unknown as {
      textGenerationModelSelection?: { options?: unknown };
    };
    expect(encoded.textGenerationModelSelection?.options).toEqual({ reasoningEffort: "high" });

    expect(decodePatch(encodedRaw)).toEqual(patch);
  });
});

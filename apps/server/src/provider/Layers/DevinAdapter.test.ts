// FILE: DevinAdapter.test.ts
// Purpose: Compact adapter/runtime contract tests for Devin session configuration,
// model discovery, and plan-mode fail-closed behavior.
// Layer: Provider adapter tests

import { Effect } from "effect";
import type * as Acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  applyDevinSessionConfiguration,
  buildDevinPromptMeta,
  buildDevinStaticModelDescriptors,
  mergeDevinModelDescriptors,
  parseDevinCliModelList,
  resolveRequestedModeId,
} from "./DevinAdapter.ts";

function makeFakeAcpRuntime(initialModeState?: {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string }>;
}): {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getModeState" | "setMode">;
  readonly calls: Array<{ method: string; args: ReadonlyArray<unknown> }>;
} {
  const calls: Array<{ method: string; args: ReadonlyArray<unknown> }> = [];
  let modeState = initialModeState;

  const runtime = {
    getModeState: Effect.sync(() =>
      modeState
        ? {
            currentModeId: modeState.currentModeId,
            availableModes: modeState.availableModes,
          }
        : undefined,
    ),
    setMode: (modeId: string) =>
      Effect.sync(() => {
        calls.push({ method: "setMode", args: [modeId] });
        if (modeState) {
          modeState = { ...modeState, currentModeId: modeId };
        }
        return {} as Acp.SetSessionModeResponse;
      }),
  };
  return { runtime, calls };
}

describe("applyDevinSessionConfiguration", () => {
  it("sets plan mode when requested", async () => {
    const { runtime, calls } = makeFakeAcpRuntime({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });

    await Effect.runPromise(
      applyDevinSessionConfiguration({
        runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    );

    expect(calls).toEqual([{ method: "setMode", args: ["plan"] }]);
  });

  it("does not touch config options for the model selection", async () => {
    // Devin models are process-start `--model` flags; the per-turn
    // set_config_option path must stay gone.
    const { runtime, calls } = makeFakeAcpRuntime();

    await Effect.runPromise(
      applyDevinSessionConfiguration({
        runtime,
        runtimeMode: "full-access",
        interactionMode: undefined,
      }),
    );

    expect(calls).toEqual([]);
  });

  it("fails closed when plan mode is not available", async () => {
    const { runtime } = makeFakeAcpRuntime({
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    });

    await expect(
      Effect.runPromise(
        applyDevinSessionConfiguration({
          runtime,
          runtimeMode: "full-access",
          interactionMode: "plan",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });
});

describe("resolveRequestedModeId", () => {
  it("selects plan mode by exact alias", async () => {
    const modeId = await Effect.runPromise(
      resolveRequestedModeId({
        modeState: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    );
    expect(modeId).toBe("plan");
  });

  it("leaves default mode unchanged for non-plan turns", async () => {
    const modeId = await Effect.runPromise(
      resolveRequestedModeId({
        modeState: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
        runtimeMode: "full-access",
        interactionMode: undefined,
      }),
    );
    expect(modeId).toBeUndefined();
  });

  it("rejects ambiguous partial mode matches", async () => {
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: {
            currentModeId: "default",
            availableModes: [{ id: "planner", name: "Planner" }],
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });
});

describe("buildDevinPromptMeta", () => {
  it("advertises plan mode through prompt metadata", () => {
    expect(buildDevinPromptMeta("plan")).toEqual({ mode: "plan" });
  });

  it("maps omitted and default modes to agent", () => {
    expect(buildDevinPromptMeta("default")).toEqual({ mode: "agent" });
  });
});

describe("buildDevinStaticModelDescriptors", () => {
  it("falls back to the static contract catalog", () => {
    const descriptors = buildDevinStaticModelDescriptors();
    expect(descriptors.some((d) => d.slug === "swe-1-7")).toBe(true);
    expect(descriptors.some((d) => d.slug === "adaptive")).toBe(true);
  });
});

describe("Devin CLI model discovery", () => {
  it("publishes reasoning, fast, context, and concrete variant metadata", () => {
    const models = parseDevinCliModelList(
      JSON.stringify({
        families: [
          {
            family_uid: "gpt-5.6-sol",
            family_label: "GPT-5.6 Sol",
            slug: "gpt-5.6-sol",
            variants: [
              {
                model_uid: "gpt-5-6-sol-medium",
                label: "GPT-5.6 Sol Medium",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-low",
                label: "GPT-5.6 Sol Low",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-high",
                label: "GPT-5.6 Sol High",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-medium-priority",
                label: "GPT-5.6 Sol Medium Priority",
                max_context_tokens: 1_000_000,
              },
            ],
          },
        ],
      }),
    );

    const [model] = mergeDevinModelDescriptors([models]);
    if (!model) throw new Error("Expected GPT-5.6 Sol to be discovered");
    expect(model).toMatchObject({
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportsFastMode: true,
      defaultContextWindow: "200k",
    });
    expect(model.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(model.contextWindowOptions?.map((option) => option.value)).toEqual(["200k", "1m"]);
    expect(model.modelVariants).toContainEqual({
      model: "gpt-5-6-sol-medium-priority",
      reasoningEffort: "medium",
      contextWindow: "1m",
      fastMode: true,
    });
  });

  it("exposes thinking and long-context toggles for Claude-style variants", () => {
    const models = parseDevinCliModelList(
      JSON.stringify({
        families: [
          {
            family_uid: "claude-opus-4.6",
            family_label: "Claude Opus 4.6",
            slug: "claude-opus-4.6",
            variants: [
              {
                model_uid: "claude-opus-4-6",
                label: "Claude Opus 4.6",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "claude-opus-4-6-thinking",
                label: "Claude Opus 4.6 Thinking",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "claude-opus-4-6-1m",
                label: "Claude Opus 4.6 1M",
                max_context_tokens: 1_000_000,
              },
              {
                model_uid: "claude-opus-4-6-thinking-1m",
                label: "Claude Opus 4.6 Thinking 1M",
                max_context_tokens: 1_000_000,
              },
            ],
          },
        ],
      }),
    );

    const [model] = mergeDevinModelDescriptors([models]);
    if (!model) throw new Error("Expected Claude Opus 4.6 to be discovered");
    expect(model).toMatchObject({
      supportsThinkingToggle: true,
      defaultContextWindow: "200k",
    });
    expect(model.contextWindowOptions?.map((option) => option.value)).toEqual(["200k", "1m"]);
    expect(model.modelVariants).toContainEqual({
      model: "claude-opus-4-6-thinking-1m",
      contextWindow: "1m",
      thinking: true,
    });
    expect(model.modelVariants).toContainEqual({
      model: "claude-opus-4-6",
      contextWindow: "200k",
      thinking: false,
    });
  });

  it("returns no descriptors for non-JSON CLI output", () => {
    expect(parseDevinCliModelList("devin: not logged in")).toEqual([]);
  });
});

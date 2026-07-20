// FILE: DevinAdapter.test.ts
// Purpose: Compact adapter/runtime contract tests for Devin session configuration,
// model discovery, and plan-mode fail-closed behavior.
// Layer: Provider adapter tests

import { Effect, Option, type Stream } from "effect";
import type * as Acp from "@agentclientprotocol/sdk";
import type * as AcpErrors from "../acp/AcpErrors.ts";
import { describe, expect, it } from "vitest";

import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  applyDevinSessionConfiguration,
  buildDevinProviderModelDescriptors,
  resolveRequestedModeId,
} from "./DevinAdapter.ts";

type MutableConfigOptions = Array<Acp.SessionConfigOption>;

function makeFakeAcpRuntime(
  initialConfigOptions: MutableConfigOptions,
  initialModeState?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> },
): {
  readonly runtime: AcpSessionRuntimeShape;
  readonly calls: Array<{ method: string; args: ReadonlyArray<unknown> }>;
  readonly configOptions: MutableConfigOptions;
} {
  const calls: Array<{ method: string; args: ReadonlyArray<unknown> }> = [];
  const configOptions = initialConfigOptions;
  let modeState = initialModeState;

  const record = (method: string, args: ReadonlyArray<unknown>) => {
    calls.push({ method, args });
  };

  const findOption = (id: string) =>
    configOptions.find((o) => o.id.toLowerCase() === id.toLowerCase());

  const setOptionCurrentValue = (id: string, value: string | boolean) => {
    const idx = configOptions.findIndex((o) => o.id.toLowerCase() === id.toLowerCase());
    if (idx === -1) return;
    const existing = configOptions[idx]!;
    configOptions[idx] = {
      ...existing,
      currentValue: value,
    } as Acp.SessionConfigOption;
  };

  const runtime = {
    start: () => Effect.succeed({ sessionId: "fake-session", resumedExistingSession: false }),
    awaitExit: Effect.void,
    getEvents: () =>
      ({
        // Empty stream placeholder; never consumed in these tests.
        [Symbol.asyncIterator]: async function* () {
          return;
        },
      }) as unknown as Stream.Stream<never, never>,
    sessionUpdatesEnqueuedCount: Effect.succeed(0),
    supportsSessionFork: Effect.succeed(false),
    getModeState: Effect.sync(() =>
      modeState
        ? {
            currentModeId: modeState.currentModeId,
            availableModes: modeState.availableModes,
          }
        : undefined,
    ),
    getConfigOptions: Effect.sync(() => configOptions),
    getAvailableCommands: Effect.succeed([]),
    prompt: () => Effect.fail(null as unknown as AcpErrors.AcpError),
    cancel: Effect.void,
    setMode: (modeId: string) =>
      Effect.sync(() => {
        record("setMode", [modeId]);
        if (modeState) {
          modeState = { ...modeState, currentModeId: modeId };
        }
        return {} as Acp.SetSessionModeResponse;
      }),
    setConfigOption: (id: string, value: string | boolean) =>
      Effect.sync(() => {
        record("setConfigOption", [id, value]);
        setOptionCurrentValue(id, value);
        return { configOptions } as Acp.SetSessionConfigOptionResponse;
      }),
    setModel: (model: string) =>
      Effect.sync(() => {
        record("setModel", [model]);
        const modelOption = configOptions.find(
          (o) => o.category === "model" || o.id.toLowerCase() === "model",
        );
        if (modelOption) {
          setOptionCurrentValue(modelOption.id, model);
        }
      }),
    forkSession: () => Effect.fail(null as unknown as AcpErrors.AcpError),
    request: () => Effect.fail(null as unknown as AcpErrors.AcpError),
    notify: () => Effect.void,
    exitCode: Effect.succeed(null),
  } as unknown as AcpSessionRuntimeShape;

  return { runtime, calls, configOptions };
}

function modelOption(
  currentValue: string,
  values: ReadonlyArray<{ value: string; name: string }>,
): Acp.SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: values as never,
  };
}

function booleanOption(id: string, name: string, currentValue: boolean): Acp.SessionConfigOption {
  return {
    id,
    name,
    category: "model_config",
    type: "boolean",
    currentValue,
  };
}

function selectOption(
  id: string,
  name: string,
  currentValue: string,
  values: ReadonlyArray<{ value: string; name: string }>,
): Acp.SessionConfigOption {
  return {
    id,
    name,
    category: "model_config",
    type: "select",
    currentValue,
    options: values as never,
  };
}

describe("applyDevinSessionConfiguration", () => {
  it("applies model and traits transactionally", async () => {
    const { runtime, calls, configOptions } = makeFakeAcpRuntime([
      modelOption("default", [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "gpt-5.4", name: "GPT-5.4" },
      ]),
      selectOption("fast", "Fast", "false", [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ]),
      selectOption("reasoning", "Reasoning", "medium", [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ]),
    ]);

    const result = await Effect.runPromise(
      applyDevinSessionConfiguration({
        runtime,
        runtimeMode: "full-access",
        interactionMode: undefined,
        modelSelection: {
          model: "composer-2",
          options: { fastMode: true, reasoningEffort: "high" },
        },
      }),
    );

    expect(result.model).toBe("composer-2");
    expect(calls).toEqual([
      { method: "setModel", args: ["composer-2"] },
      { method: "setConfigOption", args: ["fast", "true"] },
      { method: "setConfigOption", args: ["reasoning", "high"] },
    ]);
    expect(configOptions.find((o) => o.id === "fast")?.currentValue).toBe("true");
    expect(configOptions.find((o) => o.id === "reasoning")?.currentValue).toBe("high");
  });

  it("fails when the requested model is not allowed", async () => {
    const { runtime } = makeFakeAcpRuntime([
      modelOption("default", [{ value: "default", name: "Auto" }]),
    ]);

    await expect(
      Effect.runPromise(
        applyDevinSessionConfiguration({
          runtime,
          runtimeMode: "full-access",
          interactionMode: undefined,
          modelSelection: { model: "unknown-model" },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });

  it("fails when a trait value is not available", async () => {
    const { runtime } = makeFakeAcpRuntime([
      modelOption("default", [{ value: "default", name: "Auto" }]),
      selectOption("fast", "Fast", "false", [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ]),
    ]);

    await expect(
      Effect.runPromise(
        applyDevinSessionConfiguration({
          runtime,
          runtimeMode: "full-access",
          interactionMode: undefined,
          modelSelection: { model: "default", options: { reasoningEffort: "high" } },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });

  it("sets plan mode when requested", async () => {
    const { runtime, calls } = makeFakeAcpRuntime(
      [modelOption("default", [{ value: "default", name: "Auto" }])],
      {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    );

    await Effect.runPromise(
      applyDevinSessionConfiguration({
        runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
        modelSelection: { model: "default" },
      }),
    );

    expect(calls.some((call) => call.method === "setMode" && call.args[0] === "plan")).toBe(true);
  });

  it("fails closed when plan mode is not available", async () => {
    const { runtime } = makeFakeAcpRuntime(
      [modelOption("default", [{ value: "default", name: "Auto" }])],
      {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      },
    );

    await expect(
      Effect.runPromise(
        applyDevinSessionConfiguration({
          runtime,
          runtimeMode: "full-access",
          interactionMode: "plan",
          modelSelection: { model: "default" },
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

describe("buildDevinProviderModelDescriptors", () => {
  it("does not attach a cross-product of options to every model", () => {
    const descriptors = buildDevinProviderModelDescriptors([
      modelOption("default", [
        { value: "swe-1-7", name: "SWE 1.7" },
        { value: "adaptive", name: "Adaptive" },
      ]),
      selectOption("context", "Context", "128k", [
        { value: "128k", name: "128K" },
        { value: "256k", name: "256K" },
      ]),
    ]);

    const swe17 = descriptors.find((d) => d.slug === "swe-1-7");
    const adaptive = descriptors.find((d) => d.slug === "adaptive");

    expect(swe17).toBeDefined();
    expect(adaptive).toBeDefined();
    // SWE 1.7 supports fast mode; Adaptive does not.
    expect(swe17?.supportsFastMode).toBe(true);
    expect(adaptive?.supportsFastMode).toBe(false);
    // Both should have per-model static descriptors, not a shared runtime option list.
    expect((swe17?.optionDescriptors ?? []).some((d) => d.id === "context")).toBe(false);
  });

  it("uses runtime names for unknown models and falls back to the slug", () => {
    const descriptors = buildDevinProviderModelDescriptors([
      modelOption("default", [{ value: "future-model", name: "Future Model" }]),
    ]);

    expect(descriptors).toEqual([
      expect.objectContaining({ slug: "future-model", name: "Future Model" }),
    ]);
  });

  it("falls back to the static model list when no model option is present", () => {
    const descriptors = buildDevinProviderModelDescriptors(undefined);
    expect(descriptors.some((d) => d.slug === "swe-1-7")).toBe(true);
    expect(descriptors.some((d) => d.slug === "adaptive")).toBe(true);
  });
});

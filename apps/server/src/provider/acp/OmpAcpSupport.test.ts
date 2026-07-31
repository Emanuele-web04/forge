// FILE: OmpAcpSupport.test.ts
// Purpose: Verifies OMP ACP spawn, auth, mode, model, and discovery behavior.
// Layer: Provider ACP support tests

import { Effect } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  applyOmpAcpInteractionMode,
  applyOmpAcpModelSelection,
  buildOmpAcpSpawnInput,
  parseOmpCliModelList,
  resolveOmpAcpAuthMethodId,
  resolveOmpCliBinaryPath,
} from "./OmpAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("resolveOmpCliBinaryPath", () => {
  it("honors a configured binary path", () => {
    expect(resolveOmpCliBinaryPath("/opt/homebrew/bin/omp")).toBe("/opt/homebrew/bin/omp");
  });

  it("resolves to the omp name when nothing is configured", () => {
    // Either a PATH-resolved absolute path or the bare "omp" name; both end in omp.
    expect(resolveOmpCliBinaryPath("")).toMatch(/omp$/);
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("builds the default OMP ACP command", () => {
    const spawn = buildOmpAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.command.length).toBeGreaterThan(0);
    expect(spawn.env).toBeDefined();
  });

  it("honors a configured binary path without adding model flags", () => {
    // omp reads model/thinking from session config options, never CLI flags.
    const spawn = buildOmpAcpSpawnInput({ binaryPath: "/usr/local/bin/omp" }, "/tmp/project");
    expect(spawn.command).toBe("/usr/local/bin/omp");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.env).toBeDefined();
  });
});

describe("applyOmpAcpModelSelection", () => {
  function recordingRuntime(failFor?: string) {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    return {
      calls,
      runtime: {
        setConfigOption: (configId: string, value: string | boolean) => {
          if (configId === failFor) {
            return Effect.fail(
              new AcpErrors.AcpRequestError({
                code: -32602,
                errorMessage: `Unknown config option: ${configId}`,
              }),
            );
          }
          calls.push({ configId, value });
          return Effect.succeed({ configOptions: [] });
        },
      },
    };
  }

  it("sets the model before the thinking level", async () => {
    const { calls, runtime } = recordingRuntime();
    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-sonnet-4",
        thinkingLevel: "high",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([
      { configId: "model", value: "anthropic/claude-sonnet-4" },
      { configId: "thinking", value: "high" },
    ]);
  });

  it("skips the thinking RPC when no level is requested", async () => {
    const { calls, runtime } = recordingRuntime();
    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-sonnet-4",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "model", value: "anthropic/claude-sonnet-4" }]);
  });

  it("maps set_config_option failures through mapError", async () => {
    const { runtime } = recordingRuntime("model");
    const error = await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-sonnet-4",
        mapError: ({ method }) => new Error(`failed:${method}`),
      }).pipe(Effect.flip),
    );
    expect(error.message).toBe("failed:session/set_config_option");
  });
});

describe("applyOmpAcpInteractionMode", () => {
  function modeRuntime(advertisedModes: ReadonlyArray<string>) {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    const configOptions = (): ReadonlyArray<Acp.SessionConfigOption> => [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: advertisedModes.map((value) => ({ value, name: value })),
      },
    ];
    return {
      calls,
      runtime: {
        getConfigOptions: Effect.sync(configOptions),
        setConfigOption: (configId: string, value: string | boolean) => {
          calls.push({ configId, value });
          return Effect.succeed({ configOptions: [] });
        },
      },
    };
  }

  it("routes plan interaction mode to OMP plan when advertised", async () => {
    const { calls, runtime } = modeRuntime(["default", "plan"]);
    await Effect.runPromise(
      applyOmpAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "mode", value: "plan" }]);
  });

  it("leaves OMP on default when plan is requested but not advertised", async () => {
    const { calls, runtime } = modeRuntime(["default"]);
    await Effect.runPromise(
      applyOmpAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([]);
  });

  it("passes the default interaction mode through as default", async () => {
    const { calls, runtime } = modeRuntime(["default", "plan"]);
    await Effect.runPromise(
      applyOmpAcpInteractionMode({
        runtime,
        interactionMode: "default",
        runtimeMode: "full-access",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "mode", value: "default" }]);
  });

  it("leaves OMP as-is when no mode option is advertised", async () => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      getConfigOptions: Effect.sync(
        (): ReadonlyArray<Acp.SessionConfigOption> => [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "",
            options: [{ value: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }],
          },
        ],
      ),
      setConfigOption: (configId: string, value: string | boolean) => {
        calls.push({ configId, value });
        return Effect.succeed({ configOptions: [] });
      },
    };

    await Effect.runPromise(
      applyOmpAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe("parseOmpCliModelList", () => {
  it("reads each model with per-model thinking efforts from the omp catalog", () => {
    const stdout = JSON.stringify({
      models: [
        {
          provider: "alibaba-token-plan",
          id: "glm-5.2",
          selector: "alibaba-token-plan/glm-5.2",
          name: "GLM-5.2",
          contextWindow: 1000000,
          maxTokens: 131072,
          reasoning: true,
          thinking: ["minimal", "low", "medium", "high", "max"],
          input: ["text"],
        },
        {
          provider: "commandcode",
          id: "MiniMaxAI/MiniMax-M2.5",
          selector: "commandcode/MiniMaxAI/MiniMax-M2.5",
          name: "MiniMax M2.5",
          reasoning: false,
          thinking: null,
        },
      ],
    });
    const models = parseOmpCliModelList(stdout);
    expect(models).toHaveLength(2);
    expect(models).toEqual([
      expect.objectContaining({
        slug: "alibaba-token-plan/glm-5.2",
        name: "GLM-5.2",
        upstreamProviderId: "alibaba-token-plan",
        supportedReasoningEfforts: [
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "max", label: "Max" },
        ],
      }),
      expect.objectContaining({
        slug: "commandcode/MiniMaxAI/MiniMax-M2.5",
        name: "MiniMax M2.5",
        upstreamProviderId: "commandcode",
      }),
    ]);
    // A non-reasoning model (thinking: null) advertises no efforts.
    expect(models[1]).not.toHaveProperty("supportedReasoningEfforts");
  });

  it("dedupes models that share a selector", () => {
    const stdout = JSON.stringify({
      models: [
        { provider: "p", selector: "p/a", name: "A", thinking: ["high"] },
        { provider: "p", selector: "p/a", name: "A duplicate", thinking: ["high"] },
        { provider: "p", selector: "p/b", name: "B", thinking: null },
      ],
    });
    const models = parseOmpCliModelList(stdout);
    expect(models.map((m) => m.slug)).toEqual(["p/a", "p/b"]);
  });

  it("skips entries missing a selector or name and omits provider when absent", () => {
    const stdout = JSON.stringify({
      models: [
        { provider: "p", selector: "p/ok", name: "OK" },
        { provider: "p", selector: "", name: "No Selector" },
        { provider: "p", selector: "p/no-name", name: "" },
        { provider: "p", name: "No Selector Field" },
        { selector: "p/no-provider", name: "No Provider" },
      ],
    });
    const models = parseOmpCliModelList(stdout);
    expect(models.map((m) => m.slug)).toEqual(["p/ok", "p/no-provider"]);
    expect(models[1]).not.toHaveProperty("upstreamProviderId");
  });

  it("returns an empty list for malformed JSON", () => {
    expect(parseOmpCliModelList("not json")).toEqual([]);
  });

  it("returns an empty list when no models are present", () => {
    expect(parseOmpCliModelList(JSON.stringify({ models: [] }))).toEqual([]);
    expect(parseOmpCliModelList(JSON.stringify({}))).toEqual([]);
  });

  it("also accepts a bare models array as the top-level value", () => {
    const stdout = JSON.stringify([
      { provider: "p", selector: "p/x", name: "X", thinking: ["low", "xhigh"] },
    ]);
    const models = parseOmpCliModelList(stdout);
    expect(models).toEqual([
      expect.objectContaining({
        slug: "p/x",
        name: "X",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "xhigh", label: "XHigh" },
        ],
      }),
    ]);
  });

  it("canonicalizes thinking efforts: trims, lowercases, and drops unknown levels and duplicates", () => {
    const stdout = JSON.stringify({
      models: [
        {
          provider: "p",
          selector: "p/a",
          name: "A",
          thinking: ["High", "high", "turbo", "  MAX  ", "ultra"],
        },
      ],
    });
    const models = parseOmpCliModelList(stdout);
    expect(models).toEqual([
      expect.objectContaining({
        slug: "p/a",
        name: "A",
        supportedReasoningEfforts: [
          { value: "high", label: "High" },
          { value: "max", label: "Max" },
        ],
      }),
    ]);
  });

  it("advertises no efforts when every thinking value is outside the omp contract", () => {
    const stdout = JSON.stringify({
      models: [{ provider: "p", selector: "p/a", name: "A", thinking: ["turbo", "ultra"] }],
    });
    const models = parseOmpCliModelList(stdout);
    expect(models[0]).not.toHaveProperty("supportedReasoningEfforts");
  });
});

describe("resolveOmpAcpAuthMethodId", () => {
  it("selects the agent auth method backed by local ~/.omp credentials", async () => {
    const id = await Effect.runPromise(
      resolveOmpAcpAuthMethodId(initializeWithAuthMethods(["agent"])),
    );
    expect(id).toBe("agent");
  });

  it("fails when the agent auth method is unavailable", async () => {
    const error = await Effect.runPromise(
      resolveOmpAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
  });
});

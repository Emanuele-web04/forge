// FILE: DroidAcpSupport.test.ts
// Purpose: Verifies Droid ACP spawn, auth, mode, model, and discovery behavior.
// Layer: Provider ACP support tests

import nodeFs from "node:fs";
import nodeOs from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyDroidAcpInteractionMode,
  applyDroidAcpModelSelection,
  buildDroidAcpSpawnInput,
  discoverDroidAcpModels,
  resolveDroidAcpAuthMethodId,
  resolveDroidCliBinaryPath,
} from "./DroidAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("resolveDroidCliBinaryPath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns an explicit absolute path as-is even if it does not exist", () => {
    vi.spyOn(nodeFs, "existsSync").mockReturnValue(false);
    const path = "/nonexistent/bin/droid";
    expect(resolveDroidCliBinaryPath(path)).toBe(path);
  });

  it("returns an explicit relative/path-like path as-is", () => {
    vi.spyOn(nodeFs, "existsSync").mockReturnValue(false);
    expect(resolveDroidCliBinaryPath("./droid")).toBe("./droid");
    expect(resolveDroidCliBinaryPath("some/relative/droid")).toBe("some/relative/droid");
  });

  it("uses a non-default bare name that exists in the CWD", () => {
    const exists = vi
      .spyOn(nodeFs, "existsSync")
      .mockImplementation((path) => String(path) === "mydroid");

    expect(resolveDroidCliBinaryPath("mydroid")).toBe("mydroid");
    expect(exists).toHaveBeenCalledWith("mydroid");
  });

  it("searches PATH, then ~/.local/bin/droid, then falls back to droid for the bare name", () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.spyOn(nodeOs, "homedir").mockReturnValue("/home/test");

    const existing = new Set<string>();
    vi.spyOn(nodeFs, "existsSync").mockImplementation((path) => existing.has(String(path)));

    // Bare `droid` (or empty/undefined) falls back to the default name when nothing is found.
    expect(resolveDroidCliBinaryPath()).toBe("droid");
    expect(resolveDroidCliBinaryPath(undefined)).toBe("droid");
    expect(resolveDroidCliBinaryPath("")).toBe("droid");
    expect(resolveDroidCliBinaryPath("droid")).toBe("droid");

    const localBin = join("/home/test", ".local", "bin", "droid");
    if (process.platform !== "win32") {
      existing.add(localBin);
      expect(resolveDroidCliBinaryPath()).toBe(localBin);
      existing.delete(localBin);
    }

    const pathBin = "/usr/bin/droid";
    existing.add(pathBin);
    expect(resolveDroidCliBinaryPath()).toBe(pathBin);
  });
});

describe("buildDroidAcpSpawnInput", () => {
  it("builds the default Droid ACP command", () => {
    const spawn = buildDroidAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.args).toEqual(["exec", "--output-format", "acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.command.length).toBeGreaterThan(0);
    expect(spawn.env).toBeDefined();
  });

  it("does not pass model or reasoning effort to the ACP CLI; they are applied via session/set_config_option", () => {
    const spawn = buildDroidAcpSpawnInput(
      {
        appendSystemPrompt: "Run heavyweight validators serially.",
        binaryPath: "/usr/local/bin/droid",
        model: "claude-opus-4-8",
        reasoningEffort: "high",
      },
      "/tmp/project",
    );

    expect(spawn.command).toBe("/usr/local/bin/droid");
    expect(spawn.args).toEqual([
      "exec",
      "--output-format",
      "acp",
      "--append-system-prompt",
      "Run heavyweight validators serially.",
    ]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.env).toBeDefined();
  });
});

describe("applyDroidAcpModelSelection", () => {
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

  it("sets the model before the reasoning effort", async () => {
    const { calls, runtime } = recordingRuntime();
    await Effect.runPromise(
      applyDroidAcpModelSelection({
        runtime,
        model: "minimax-m3",
        reasoningEffort: "high",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([
      { configId: "model", value: "minimax-m3" },
      { configId: "reasoning_effort", value: "high" },
    ]);
  });

  it("skips the reasoning effort RPC when no effort is requested", async () => {
    const { calls, runtime } = recordingRuntime();
    await Effect.runPromise(
      applyDroidAcpModelSelection({
        runtime,
        model: "claude-opus-4-8",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "model", value: "claude-opus-4-8" }]);
  });

  it("maps set_config_option failures through mapError", async () => {
    const { runtime } = recordingRuntime("model");
    const error = await Effect.runPromise(
      applyDroidAcpModelSelection({
        runtime,
        model: "claude-opus-4-8",
        mapError: ({ method }) => new Error(`failed:${method}`),
      }).pipe(Effect.flip),
    );
    expect(error.message).toBe("failed:session/set_config_option");
  });
});

describe("applyDroidAcpInteractionMode", () => {
  it("uses native spec mode for Plan and restores Full Access on the next turn", async () => {
    const calls: string[] = [];
    const runtime = {
      setMode: (modeId: string) => {
        calls.push(modeId);
        return Effect.succeed({});
      },
      setConfigOption: () => Effect.succeed({ configOptions: [] }),
    };

    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        runtimeMode: "full-access",
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "default",
        runtimeMode: "full-access",
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual(["spec", "auto-high"]);
  });

  it("uses Droid's highest native autonomy outside plan mode for full-access sessions", async () => {
    const calls: string[] = [];
    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime: {
          setMode: (modeId: string) => {
            calls.push(modeId);
            return Effect.succeed({});
          },
          setConfigOption: () => Effect.succeed({ configOptions: [] }),
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual(["auto-high"]);
  });

  it("falls back to Droid's autonomy config for older ACP mode responses", async () => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      setMode: () =>
        Effect.fail(
          new AcpErrors.AcpRequestError({ code: -32601, errorMessage: "mode unavailable" }),
        ),
      setConfigOption: (configId: string, value: string | boolean) => {
        calls.push({ configId, value });
        return Effect.succeed({ configOptions: [] });
      },
    };

    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "autonomy_level", value: "spec" }]);
  });
});

describe("discoverDroidAcpModels", () => {
  it("reads each model's reasoning choices from session config options", async () => {
    let currentModel = "model-a";
    const configOptions = (): ReadonlyArray<Acp.SessionConfigOption> => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModel,
        options: [
          {
            value: "model-a",
            name: "Model A",
            description: "0.4x Factory token rate",
          },
          { value: "model-b", name: "Model B" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: currentModel === "model-a" ? "medium" : "max",
        options:
          currentModel === "model-a"
            ? [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
              ]
            : [
                { value: "high", name: "High" },
                { value: "max", name: "Max" },
              ],
      },
    ];
    const runtime = {
      getConfigOptions: Effect.sync(configOptions),
      setConfigOption: (configId: string, value: string | boolean) => {
        if (configId === "model") {
          currentModel = String(value);
        }
        return Effect.succeed({ configOptions: [...configOptions()] });
      },
    };

    const result = await Effect.runPromise(discoverDroidAcpModels(runtime));
    expect(result.models).toEqual([
      expect.objectContaining({
        slug: "model-a",
        description: "0.4x Factory token rate",
        optionDescriptors: [
          expect.objectContaining({ id: "reasoningEffort", currentValue: "medium" }),
        ],
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
        ],
      }),
      expect.objectContaining({
        slug: "model-b",
        optionDescriptors: [
          expect.objectContaining({ id: "reasoningEffort", currentValue: "max" }),
        ],
        supportedReasoningEfforts: [
          { value: "high", label: "High" },
          { value: "max", label: "Max" },
        ],
      }),
    ]);
    const modelB = result.models[1];
    if (!modelB) {
      throw new Error("Expected model-b to be present.");
    }
    expect(modelB.description).toBeUndefined();
    expect(currentModel).toBe("model-a");
  });
});

describe("resolveDroidAcpAuthMethodId", () => {
  const previousFactoryApiKey = process.env.FACTORY_API_KEY;

  afterEach(() => {
    if (previousFactoryApiKey === undefined) {
      delete process.env.FACTORY_API_KEY;
    } else {
      process.env.FACTORY_API_KEY = previousFactoryApiKey;
    }
  });

  it("prefers factory-api-key when FACTORY_API_KEY is set", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    const id = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods(["factory-api-key", "device-pairing"])),
    );
    expect(id).toBe("factory-api-key");
  });

  it("falls back to device-pairing", async () => {
    delete process.env.FACTORY_API_KEY;
    const id = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods(["device-pairing"])),
    );
    expect(id).toBe("device-pairing");
  });

  it("fails when no auth method is available", async () => {
    delete process.env.FACTORY_API_KEY;
    const error = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
  });
});

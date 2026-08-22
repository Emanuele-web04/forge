import { Effect } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAcpPermissionPolicy } from "./AcpAdapterSupport.ts";
import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  isGrokSessionStoragePathNotFoundError,
  resolveGrokAcpAuthMethodId,
  runGrokAcpCompactionCommand,
} from "./GrokAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildGrokAcpSpawnInput", () => {
  it("builds the default Grok ACP command", () => {
    expect(buildGrokAcpSpawnInput(undefined, "/tmp/project", "approval-required")).toMatchObject({
      command: "grok",
      args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Grok binary path", () => {
    expect(
      buildGrokAcpSpawnInput(
        { binaryPath: "/usr/local/bin/grok" },
        "/tmp/project",
        "approval-required",
      ),
    ).toMatchObject({
      command: "/usr/local/bin/grok",
      args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
    });
  });

  it("passes model and reasoning effort without process-wide approval overrides", () => {
    const spawn = buildGrokAcpSpawnInput(
      {
        binaryPath: "/usr/local/bin/grok",
        model: "grok-build",
        reasoningEffort: "high",
      },
      "/tmp/project",
      "approval-required",
    );

    expect(spawn).toMatchObject({
      command: "/usr/local/bin/grok",
      args: [
        "--permission-mode",
        "default",
        "agent",
        "--no-leader",
        "-m",
        "grok-build",
        "--reasoning-effort",
        "high",
        "stdio",
      ],
      cwd: "/tmp/project",
    });
    expect(spawn.args).not.toContain("--always-approve");
  });

  it("passes Grok 4.6 extra-high reasoning effort to the CLI", () => {
    expect(
      buildGrokAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/grok",
          model: "grok-4.6",
          reasoningEffort: "xhigh",
        },
        "/tmp/project",
        "approval-required",
      ).args,
    ).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
      "stdio",
    ]);
  });

  it("uses Grok's process-scoped approval override only for Full Access", () => {
    expect(buildGrokAcpSpawnInput(undefined, "/tmp/project", "full-access").args).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "--always-approve",
      "stdio",
    ]);
  });
});

describe("isGrokSessionStoragePathNotFoundError", () => {
  it("matches Grok's stable persistence code", () => {
    expect(
      isGrokSessionStoragePathNotFoundError(
        new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Path not found.",
          data: { code: "FS_NOT_FOUND", detail: "No such file or directory (os error 2)" },
        }),
      ),
    ).toBe(true);
  });

  it("does not retry other ACP or filesystem failures", () => {
    expect(
      isGrokSessionStoragePathNotFoundError(
        new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Permission denied.",
          data: { code: "FS_PERMISSION_DENIED" },
        }),
      ),
    ).toBe(false);
    expect(
      isGrokSessionStoragePathNotFoundError(
        new AcpErrors.AcpTransportError({
          detail: "connection closed",
          cause: new Error("connection closed"),
        }),
      ),
    ).toBe(false);
  });
});

describe("resolveGrokAcpAuthMethodId", () => {
  const previousXaiApiKey = process.env.XAI_API_KEY;
  const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;

  afterEach(() => {
    if (previousXaiApiKey === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = previousXaiApiKey;
    }
    if (previousApiKey === undefined) {
      delete process.env.GROK_CODE_XAI_API_KEY;
    } else {
      process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
    }
  });

  it("prefers the xAI API key auth method when XAI_API_KEY is present", async () => {
    process.env.XAI_API_KEY = "xai-test-key";

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("still accepts the legacy Grok API key env var", async () => {
    delete process.env.XAI_API_KEY;
    process.env.GROK_CODE_XAI_API_KEY = "xai-test-key";

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("falls back to cached token auth when no API key is configured", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("cached_token");
  });

  it("identifies an interactive-only advertisement as missing headless credentials", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["browser_login"])).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("not authenticated for headless ACP");
    expect(error.message).toContain("browser_login");
  });

  it("explains when an advertised API-key method has no configured key", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["xai.api_key"])).pipe(Effect.flip),
    );

    expect(error.message).toContain("XAI_API_KEY is not set");
  });

  it("distinguishes an API-key advertisement mismatch from missing credentials", async () => {
    process.env.XAI_API_KEY = "xai-test-key";

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["grok.com"])).pipe(Effect.flip),
    );

    expect(error.message).toContain("did not advertise API-key authentication");
    expect(error.message).toContain("grok.com");
  });

  it("reports unknown or empty auth advertisements as a compatibility mismatch", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const unknownError = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["future_auth"])).pipe(Effect.flip),
    );
    const emptyError = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );

    expect(unknownError.message).toContain("advertised: future_auth");
    expect(emptyError.message).toContain("advertised: none");
  });
});

describe("Grok ACP permission policy", () => {
  const options = [
    { kind: "allow_once", optionId: "allow-once" },
    { kind: "reject_once", optionId: "reject-once" },
  ] as const;

  it("surfaces approval-required requests to Synara", () => {
    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "approval-required",
        interactionMode: "default",
        options,
      }),
    ).toBeUndefined();
  });

  it("auto-allows Full Access requests with the provider's request-scoped option", () => {
    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "full-access",
        interactionMode: "default",
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("keeps Plan mode fail-closed above Full Access", () => {
    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "full-access",
        interactionMode: "plan",
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "reject-once" });
  });
});

describe("applyGrokAcpModelSelection", () => {
  it("does not call Grok's unsupported ACP config-option method", async () => {
    const calls: Array<
      { type: "model"; value: string } | { type: "config"; id: string; value: string }
    > = [];
    const runtime = {
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      getConfigOptions: Effect.succeed([
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          category: "model_config",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ] as ReadonlyArray<Acp.SessionConfigOption>),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", id, value: String(value) });
          return { configOptions: [] };
        }),
    };

    await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime,
        model: "grok-build",
        options: { reasoningEffort: "high" },
        mapError: (context) => context,
      }),
    );

    expect(calls).toEqual([]);
  });
});

describe("runGrokAcpCompactionCommand", () => {
  it("runs Grok's advertised /compact command explicitly in agent mode", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "compact",
          description: "Compress conversation history to save context window",
        },
      ]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await expect(Effect.runPromise(runGrokAcpCompactionCommand(runtime))).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(prompts).toEqual([
      {
        prompt: [{ type: "text", text: "/compact" }],
        _meta: { mode: "agent" },
      },
    ]);
  });

  it("keeps /compact compatible when an older Grok ACP advertises no commands", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await Effect.runPromise(runGrokAcpCompactionCommand(runtime));

    expect(prompts).toHaveLength(1);
  });

  it("fails clearly when Grok advertises commands without /compact", async () => {
    let promptCalled = false;
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "review",
          description: "Review changes",
        },
      ]),
      prompt: (_payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          promptCalled = true;
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    const error = await Effect.runPromise(runGrokAcpCompactionCommand(runtime).pipe(Effect.flip));

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("does not advertise the /compact command");
    expect(promptCalled).toBe(false);
  });
});

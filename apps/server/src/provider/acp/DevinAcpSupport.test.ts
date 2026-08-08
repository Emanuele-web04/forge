import { Effect } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpAuthenticateMeta,
  buildDevinAcpSpawnInput,
  mapDevinAcpCommands,
  parseDevinCredentialsToml,
  resolveDevinAcpAuthMethodId,
  resolveDevinCredentialsPath,
  runDevinAcpCompactionCommand,
} from "./DevinAcpSupport.ts";

describe("mapDevinAcpCommands", () => {
  it("maps Devin ACP command descriptors for the composer", () => {
    expect(
      mapDevinAcpCommands([
        { name: "compact", description: "Compact the current context" },
        { name: "plan" },
      ]),
    ).toEqual([{ name: "compact", description: "Compact the current context" }, { name: "plan" }]);
  });
});

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project", "approval-required")).toMatchObject({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Devin binary path", () => {
    expect(
      buildDevinAcpSpawnInput(
        { binaryPath: "/usr/local/bin/devin" },
        "/tmp/project",
        "approval-required",
      ),
    ).toMatchObject({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes the model as a process-start flag", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin", model: "opus" },
      "/tmp/project",
      "approval-required",
    );

    expect(spawn).toMatchObject({
      command: "/usr/local/bin/devin",
      args: ["acp", "--model", "opus"],
      cwd: "/tmp/project",
    });
  });
});

describe("resolveDevinAcpAuthMethodId", () => {
  const previousWindsurfApiKey = process.env.WINDSURF_API_KEY;
  const previousDevinApiKey = process.env.DEVIN_API_KEY;

  afterEach(() => {
    if (previousWindsurfApiKey === undefined) {
      delete process.env.WINDSURF_API_KEY;
    } else {
      process.env.WINDSURF_API_KEY = previousWindsurfApiKey;
    }
    if (previousDevinApiKey === undefined) {
      delete process.env.DEVIN_API_KEY;
    } else {
      process.env.DEVIN_API_KEY = previousDevinApiKey;
    }
  });

  it("prefers the Devin API-key auth method when WINDSURF_API_KEY is present", async () => {
    process.env.WINDSURF_API_KEY = "windsurf-test-key";

    await expect(
      Effect.runPromise(
        resolveDevinAcpAuthMethodId(
          initializeWithAuthMethods(["cached_token", "windsurf.api_key"]),
        ),
      ),
    ).resolves.toBe("windsurf.api_key");
  });

  it("accepts the DEVIN_API_KEY env var as a fallback", async () => {
    delete process.env.WINDSURF_API_KEY;
    process.env.DEVIN_API_KEY = "devin-test-key";

    await expect(
      Effect.runPromise(
        resolveDevinAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "api_key"])),
      ),
    ).resolves.toBe("api_key");
  });

  it("uses the canonical headless method when Devin only advertises browser auth", async () => {
    delete process.env.WINDSURF_API_KEY;
    delete process.env.DEVIN_API_KEY;

    await expect(
      Effect.runPromise(
        resolveDevinAcpAuthMethodId(initializeWithAuthMethods(["devin-browser"]), {
          apiKey: "stored-key",
        }),
      ),
    ).resolves.toBe("windsurf-api-key");
  });

  it("falls back to cached token auth when no API key is configured", async () => {
    delete process.env.WINDSURF_API_KEY;
    delete process.env.DEVIN_API_KEY;

    await expect(
      Effect.runPromise(
        resolveDevinAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "api_key"])),
      ),
    ).resolves.toBe("cached_token");
  });

  it("accepts any non-interactive advertised method for `devin auth login` credentials", async () => {
    delete process.env.WINDSURF_API_KEY;
    delete process.env.DEVIN_API_KEY;

    await expect(
      Effect.runPromise(
        resolveDevinAcpAuthMethodId(initializeWithAuthMethods(["custom_token_flow"])),
      ),
    ).resolves.toBe("custom_token_flow");
  });

  it("identifies an interactive-only advertisement as missing headless credentials", async () => {
    delete process.env.WINDSURF_API_KEY;
    delete process.env.DEVIN_API_KEY;

    const error = await Effect.runPromise(
      resolveDevinAcpAuthMethodId(initializeWithAuthMethods(["devin-browser"])).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("will not open a browser during a message send");
    expect(error.message).toContain("devin-browser");
  });

  it("reports unknown or empty auth advertisements as a compatibility mismatch", async () => {
    delete process.env.WINDSURF_API_KEY;
    delete process.env.DEVIN_API_KEY;

    const emptyError = await Effect.runPromise(
      resolveDevinAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );

    expect(emptyError.message).toContain("advertised: none");
  });
});

describe("Devin stored credentials", () => {
  it("parses the API key and server URL without exposing unrelated fields", () => {
    expect(
      parseDevinCredentialsToml(`
# Devin CLI credentials
windsurf_api_key = "stored-key"
api_server_url = 'https://server.codeium.com'
devin_webapp_host = "https://app.devin.ai"
`),
    ).toEqual({
      apiKey: "stored-key",
      apiServerUrl: "https://server.codeium.com",
    });
  });

  it("resolves the platform credential path from XDG data home", () => {
    expect(
      resolveDevinCredentialsPath(
        { HOME: "/home/test", XDG_DATA_HOME: "/home/test/data" },
        "linux",
      ),
    ).toBe("/home/test/data/devin/credentials.toml");
  });

  it("passes the stored API key to Devin ACP as host auth metadata", () => {
    expect(
      buildDevinAcpAuthenticateMeta({
        credentials: {
          apiKey: "stored-key",
          apiServerUrl: "https://server.codeium.com",
        },
        env: {},
      }),
    ).toEqual({
      headless: true,
      api_key: "stored-key",
      api_server_url: "https://server.codeium.com",
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  it("does not call Devin's unsupported ACP config-option method", async () => {
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
          id: "model",
          name: "Model",
          category: "model_config",
          type: "select",
          currentValue: "adaptive",
          options: [{ value: "adaptive", name: "Adaptive" }],
        },
      ] as ReadonlyArray<Acp.SessionConfigOption>),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", id, value: String(value) });
          return { configOptions: [] };
        }),
    };

    await Effect.runPromise(
      applyDevinAcpModelSelection({
        runtime,
        model: "opus",
        options: { fastMode: true },
        mapError: (context) => context,
      }),
    );

    expect(calls).toEqual([]);
  });
});

describe("runDevinAcpCompactionCommand", () => {
  it("runs Devin's advertised /compact command explicitly in agent mode", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "compact",
          description: "Force conversation compaction",
        },
      ]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await expect(Effect.runPromise(runDevinAcpCompactionCommand(runtime))).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(prompts).toEqual([
      {
        prompt: [{ type: "text", text: "/compact" }],
        _meta: { mode: "agent" },
      },
    ]);
  });

  it("keeps /compact compatible when an older Devin ACP advertises no commands", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await Effect.runPromise(runDevinAcpCompactionCommand(runtime));

    expect(prompts).toHaveLength(1);
  });

  it("fails clearly when Devin advertises commands without /compact", async () => {
    let promptCalled = false;
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "plan",
          description: "Plan changes",
        },
      ]),
      prompt: (_payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          promptCalled = true;
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    const error = await Effect.runPromise(runDevinAcpCompactionCommand(runtime).pipe(Effect.flip));

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("does not advertise the /compact command");
    expect(promptCalled).toBe(false);
  });
});

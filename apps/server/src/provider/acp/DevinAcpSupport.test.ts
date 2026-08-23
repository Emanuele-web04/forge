import { Effect } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDevinAcpAuthenticateMeta,
  buildDevinAcpSpawnInput,
  mapDevinAcpCommands,
  parseDevinCredentialsToml,
  resolveDevinAcpAuthMethodId,
  resolveDevinCredentialsPath,
  runDevinAcpCompactionCommand,
  validateDevinApiServerUrl,
} from "./DevinAcpSupport.ts";

describe("mapDevinAcpCommands", () => {
  it("maps Devin ACP command descriptors for the composer", () => {
    expect(
      mapDevinAcpCommands([
        { name: "compact", description: "Compact the current context" },
        { name: "plan", description: "Plan the current task" },
      ]),
    ).toEqual([
      { name: "compact", description: "Compact the current context" },
      { name: "plan", description: "Plan the current task" },
    ]);
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

  it("passes the stored API key to Devin ACP as host auth metadata", async () => {
    await expect(
      Effect.runPromise(
        buildDevinAcpAuthenticateMeta({
          credentials: {
            apiKey: "stored-key",
            apiServerUrl: "https://server.codeium.com",
          },
          env: {},
        }),
      ),
    ).resolves.toEqual({
      headless: true,
      api_key: "stored-key",
      api_server_url: "https://server.codeium.com",
    });
  });
});

describe("validateDevinApiServerUrl", () => {
  it("accepts an HTTPS enterprise URL", () => {
    expect(validateDevinApiServerUrl("https://server.codeium.com")).toEqual({
      kind: "url",
      url: "https://server.codeium.com",
    });
  });

  it("accepts HTTPS URLs with a path prefix", () => {
    expect(validateDevinApiServerUrl("https://devin.internal.example/base")).toEqual({
      kind: "url",
      url: "https://devin.internal.example/base",
    });
  });

  it.each(["http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"])(
    "accepts explicit loopback HTTP (%s)",
    (url) => {
      expect(validateDevinApiServerUrl(url)).toEqual({ kind: "url", url });
    },
  );

  it("normalizes trailing slashes and strips fragments", () => {
    expect(validateDevinApiServerUrl("https://server.codeium.com/")).toEqual({
      kind: "url",
      url: "https://server.codeium.com",
    });
  });

  it("rejects insecure non-loopback HTTP", () => {
    expect(validateDevinApiServerUrl("http://server.codeium.com")).toEqual({
      kind: "rejected",
      reason: "insecure_non_loopback",
    });
  });

  it("rejects malformed URLs", () => {
    expect(validateDevinApiServerUrl("not a url")).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  it("rejects credential-bearing URLs", () => {
    expect(validateDevinApiServerUrl("https://user:pass@server.codeium.com")).toEqual({
      kind: "rejected",
      reason: "credentials_in_url",
    });
  });

  it.each([
    "ftp://server.codeium.com",
    "file:///etc/passwd",
    "ws://server.codeium.com",
    "javascript:alert(1)",
  ])("rejects unsafe schemes (%s)", (url) => {
    expect(validateDevinApiServerUrl(url)).toEqual({
      kind: "rejected",
      reason: "unsupported_scheme",
    });
  });

  it("treats an unset or blank URL as not configured", () => {
    expect(validateDevinApiServerUrl(undefined)).toEqual({ kind: "unset" });
    expect(validateDevinApiServerUrl("   ")).toEqual({ kind: "unset" });
  });
});

describe("buildDevinAcpAuthenticateMeta server URL validation", () => {
  it("allows an explicit loopback HTTP server URL", async () => {
    await expect(
      Effect.runPromise(
        buildDevinAcpAuthenticateMeta({
          credentials: { apiKey: "stored-key", apiServerUrl: "http://127.0.0.1:8000" },
          env: {},
        }),
      ),
    ).resolves.toEqual({
      headless: true,
      api_key: "stored-key",
      api_server_url: "http://127.0.0.1:8000",
    });
  });

  it("attaches the API key without a configured server URL", async () => {
    await expect(
      Effect.runPromise(
        buildDevinAcpAuthenticateMeta({
          credentials: { apiKey: "stored-key" },
          env: {},
        }),
      ),
    ).resolves.toEqual({ headless: true, api_key: "stored-key" });
  });

  it("refuses to attach the API key when the server URL is rejected", async () => {
    const error = await Effect.runPromise(
      buildDevinAcpAuthenticateMeta({
        credentials: { apiKey: "stored-key", apiServerUrl: "http://evil.example.com" },
        env: {},
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    // The auth error is sanitized: neither the key nor the offending URL is echoed.
    expect(error.message).not.toContain("stored-key");
    expect(error.message).not.toContain("evil.example.com");
    expect(error.message).toContain("HTTPS");
  });

  it("lets the env server URL override a rejected stored URL", async () => {
    await expect(
      Effect.runPromise(
        buildDevinAcpAuthenticateMeta({
          credentials: { apiKey: "stored-key", apiServerUrl: "http://evil.example.com" },
          env: { WINDSURF_API_SERVER_URL: "https://server.codeium.com" },
        }),
      ),
    ).resolves.toEqual({
      headless: true,
      api_key: "stored-key",
      api_server_url: "https://server.codeium.com",
    });
  });

  it("refuses to attach the key when the env server URL is rejected", async () => {
    const error = await Effect.runPromise(
      buildDevinAcpAuthenticateMeta({
        credentials: { apiKey: "stored-key", apiServerUrl: "https://server.codeium.com" },
        env: { WINDSURF_API_SERVER_URL: "http://insecure.example.com" },
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
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

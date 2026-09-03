import { Effect, Layer } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import * as OfficialAcp from "@agentclientprotocol/sdk";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcpSessionRuntime,
  normalizeAcpIncomingJsonMessages,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";
import {
  buildDevinAcpAuthenticateMeta,
  buildDevinAcpSpawnInput,
  makeDevinAcpRuntime,
  mapDevinAcpCommands,
  normalizeDevinGetOutputToolCall,
  parseDevinCredentialsToml,
  resolveDevinAcpAuthMethodId,
  resolveDevinCredentialsPath,
  runDevinAcpCompactionCommand,
  validateDevinApiServerUrl,
} from "./DevinAcpSupport.ts";

const textEncoder = new TextEncoder();

type GetOutputArguments = {
  readonly shell_id: string;
  readonly timeout: number;
  readonly incremental: boolean;
};

function parseDevinGetOutputParams(value: unknown): { readonly arguments: GetOutputArguments } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw OfficialAcp.RequestError.invalidParams();
  }
  const params = value as Record<string, unknown>;
  const argumentsValue = params.arguments;
  if (
    Object.keys(params).some((key) => key !== "arguments") ||
    typeof argumentsValue !== "object" ||
    argumentsValue === null ||
    Array.isArray(argumentsValue)
  ) {
    throw OfficialAcp.RequestError.invalidParams();
  }
  const args = argumentsValue as Record<string, unknown>;
  if (
    Object.keys(args).some(
      (key) => key !== "shell_id" && key !== "timeout" && key !== "incremental",
    ) ||
    typeof args.shell_id !== "string" ||
    typeof args.timeout !== "number" ||
    typeof args.incremental !== "boolean"
  ) {
    throw OfficialAcp.RequestError.invalidParams();
  }
  return {
    arguments: {
      shell_id: args.shell_id,
      timeout: args.timeout,
      incremental: args.incremental,
    },
  };
}

async function normalizeTransportChunks(
  chunks: ReadonlyArray<Uint8Array>,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  const stream = normalizeAcpIncomingJsonMessages(input, normalizeDevinGetOutputToolCall);
  const messagesPromise = (async () => {
    const messages: Record<string, unknown>[] = [];
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) messages.push(JSON.parse(pending) as Record<string, unknown>);
    return messages;
  })();
  for (const chunk of chunks) controller.enqueue(chunk);
  controller.close();
  return messagesPromise;
}

function getOutputRequest(
  id: number,
  argumentsValue: Record<string, unknown>,
  extraParams: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "get_output",
    params: { arguments: argumentsValue, ...extraParams },
  });
}

function requestArguments(message: Record<string, unknown>): Record<string, unknown> {
  return ((message.params as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;
}

describe("AcpSessionRuntime Devin incoming byte transport normalization", () => {
  it("normalizes one get_output request split across byte chunks", async () => {
    const request = `${getOutputRequest(1, {
      shell_id: "split-shell",
      block: true,
      timeout: 25_000,
      incremental: true,
    })}\n`;
    const splitAt = Math.floor(request.length / 2);
    const [message] = await normalizeTransportChunks([
      textEncoder.encode(request.slice(0, splitAt)),
      textEncoder.encode(request.slice(splitAt)),
    ]);
    expect(requestArguments(message!)).toEqual({
      shell_id: "split-shell",
      timeout: 25_000,
      incremental: true,
    });
  });

  it("normalizes multiple JSON lines in one chunk in order", async () => {
    const messages = await normalizeTransportChunks([
      textEncoder.encode(
        [
          getOutputRequest(1, {
            shell_id: "first-shell",
            block: false,
            timeout: 1,
            incremental: false,
          }),
          getOutputRequest(2, {
            shell_id: "second-shell",
            block: true,
            timeout: 2,
            incremental: true,
          }),
        ].join("\n") + "\n",
      ),
    ]);
    expect(messages.map(requestArguments)).toEqual([
      { shell_id: "first-shell", timeout: 1, incremental: false },
      { shell_id: "second-shell", timeout: 2, incremental: true },
    ]);
  });

  it("preserves multibyte UTF-8 split across chunks", async () => {
    const bytes = textEncoder.encode(
      `${getOutputRequest(1, {
        shell_id: "shell-雪",
        block: true,
        timeout: 3,
        incremental: true,
      })}\n`,
    );
    const multibyteStart = bytes.indexOf(0xe9);
    expect(multibyteStart).toBeGreaterThan(0);
    const [message] = await normalizeTransportChunks([
      bytes.subarray(0, multibyteStart + 1),
      bytes.subarray(multibyteStart + 1),
    ]);
    expect(requestArguments(message!)).toEqual({
      shell_id: "shell-雪",
      timeout: 3,
      incremental: true,
    });
  });

  it("flushes final valid input without a trailing newline at EOF", async () => {
    const [message] = await normalizeTransportChunks([
      textEncoder.encode(
        getOutputRequest(1, {
          shell_id: "eof-shell",
          block: true,
          timeout: 4,
          incremental: true,
        }),
      ),
    ]);
    expect(requestArguments(message!)).toEqual({
      shell_id: "eof-shell",
      timeout: 4,
      incremental: true,
    });
  });

  it("lets the SDK skip an invalid line and handle the following normalized request", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
    });
    const handled: GetOutputArguments[] = [];
    const responses: Array<{ readonly id?: number; readonly result?: unknown }> = [];
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        responses.push(
          JSON.parse(new TextDecoder().decode(chunk).trim()) as {
            readonly id?: number;
            readonly result?: unknown;
          },
        );
      },
    });
    const connection = OfficialAcp.client({ name: "transport-recovery-test" })
      .onRequest("get_output", parseDevinGetOutputParams, ({ params }) => {
        handled.push(params.arguments);
        return { output: params.arguments.shell_id };
      })
      .connect(
        OfficialAcp.ndJsonStream(
          output,
          normalizeAcpIncomingJsonMessages(input, normalizeDevinGetOutputToolCall),
        ),
      );
    controller.enqueue(
      textEncoder.encode(
        `not-json\n${getOutputRequest(1, {
          shell_id: "recovered-shell",
          block: true,
          timeout: 5,
          incremental: true,
        })}\n`,
      ),
    );
    controller.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual([{ shell_id: "recovered-shell", timeout: 5, incremental: true }]);
    expect(responses).toEqual([{ jsonrpc: "2.0", id: 1, result: { output: "recovered-shell" } }]);
    connection.close();
  });

  it("preserves an invalid line while normalizing the following valid JSON line", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
    });
    const reader = normalizeAcpIncomingJsonMessages(
      input,
      normalizeDevinGetOutputToolCall,
    ).getReader();
    controller.enqueue(
      textEncoder.encode(
        `not-json\n${getOutputRequest(1, {
          shell_id: "recovered-shell",
          block: true,
          timeout: 5,
          incremental: true,
        })}\n`,
      ),
    );
    controller.close();
    const decoded: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      decoded.push(new TextDecoder().decode(value));
    }
    expect(decoded[0]).toBe("not-json\n");
    expect(requestArguments(JSON.parse(decoded[1]!) as Record<string, unknown>)).toEqual({
      shell_id: "recovered-shell",
      timeout: 5,
      incremental: true,
    });
  });

  it("removes exactly boolean block and preserves shell_id, timeout, and incremental", async () => {
    const [message] = await normalizeTransportChunks([
      textEncoder.encode(
        `${getOutputRequest(1, {
          shell_id: "exact-shell",
          block: true,
          timeout: 6,
          incremental: false,
        })}\n`,
      ),
    ]);
    expect(requestArguments(message!)).toEqual({
      shell_id: "exact-shell",
      timeout: 6,
      incremental: false,
    });
  });
});

describe("normalizeDevinGetOutputToolCall", () => {
  it("removes only a boolean block from Devin get_output arguments", () => {
    expect(
      normalizeDevinGetOutputToolCall({
        jsonrpc: "2.0",
        id: 1,
        method: "get_output",
        params: {
          arguments: {
            shell_id: "ed1fa1",
            block: true,
            timeout: 25000,
            incremental: true,
          },
        },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "get_output",
      params: {
        arguments: { shell_id: "ed1fa1", timeout: 25000, incremental: true },
      },
    });
  });

  it("preserves unrelated unknown fields for strict validation", () => {
    const message = {
      method: "get_output",
      params: { arguments: { shell_id: "ed1fa1", block: true, timeout: 25000, extra: true } },
    };
    expect(normalizeDevinGetOutputToolCall(message)).toEqual({
      method: "get_output",
      params: { arguments: { shell_id: "ed1fa1", timeout: 25000, extra: true } },
    });
  });

  it("keeps non-boolean block values for strict validation", () => {
    const message = {
      method: "get_output",
      params: { arguments: { shell_id: "ed1fa1", block: "true", timeout: 25000 } },
    };
    expect(normalizeDevinGetOutputToolCall(message)).toBe(message);
  });
});

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

  it("uses the scoped config environment without placing secrets in args", () => {
    const spawn = buildDevinAcpSpawnInput(undefined, "/tmp/project", "approval-required", {
      HOME: "/real/home",
      XDG_DATA_HOME: "/real/data",
      XDG_CONFIG_HOME: "/private/config",
      SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "bootstrap-must-not-propagate",
    });

    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.env).toMatchObject({
      HOME: "/real/home",
      XDG_DATA_HOME: "/real/data",
      XDG_CONFIG_HOME: "/private/config",
    });
    expect(JSON.stringify(spawn.args)).not.toContain("bootstrap-must-not-propagate");
  });
});

describe("makeDevinAcpRuntime", () => {
  it("selects on-demand authentication for the production runtime path", async () => {
    const fakeRuntime = {} as AcpSessionRuntimeShape;
    let capturedOptions: AcpSessionRuntimeOptions | undefined;
    const layerSpy = vi.spyOn(AcpSessionRuntime, "layer").mockImplementation((options) => {
      capturedOptions = options;
      return Layer.succeed(AcpSessionRuntime, fakeRuntime);
    });
    vi.stubEnv("HOME", "/tmp/synara-devin-acp-runtime-options-test");
    vi.stubEnv("XDG_DATA_HOME", "/tmp/synara-devin-acp-runtime-options-test");
    vi.stubEnv("APPDATA", "/tmp/synara-devin-acp-runtime-options-test");
    vi.stubEnv("WINDSURF_API_KEY", "");
    vi.stubEnv("DEVIN_API_KEY", "");
    vi.stubEnv("windsurf_api_key", "");
    vi.stubEnv("WINDSURF_API_SERVER_URL", "");
    vi.stubEnv("DEVIN_API_SERVER_URL", "");

    try {
      const runtime = await Effect.runPromise(
        makeDevinAcpRuntime({
          childProcessSpawner: {} as ChildProcessSpawner.ChildProcessSpawner["Service"],
          devinSettings: undefined,
          runtimeMode: "approval-required",
          cwd: "/tmp/project",
          clientInfo: { name: "Synara", version: "0.0.0" },
        }).pipe(Effect.scoped),
      );

      expect(runtime).toBe(fakeRuntime);
      expect(capturedOptions?.authPolicy).toBe("on-demand");
      expect(capturedOptions?.validateInitializeResult).toBeTypeOf("function");
      expect(capturedOptions?.normalizeIncomingMessage).toBe(normalizeDevinGetOutputToolCall);

      await expect(
        Effect.runPromise(
          capturedOptions!.validateInitializeResult!(
            initializeWithAuthMethods(["cached_token", "api_key"]),
          ),
        ),
      ).resolves.toBeUndefined();
    } finally {
      layerSpy.mockRestore();
      vi.unstubAllEnvs();
    }
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

  it("fails the production validator early with interactive-only login guidance", async () => {
    const fakeRuntime = {} as AcpSessionRuntimeShape;
    let capturedOptions: AcpSessionRuntimeOptions | undefined;
    const layerSpy = vi.spyOn(AcpSessionRuntime, "layer").mockImplementation((options) => {
      capturedOptions = options;
      return Layer.succeed(AcpSessionRuntime, fakeRuntime);
    });
    vi.stubEnv("HOME", "/tmp/synara-devin-acp-runtime-interactive-test");
    vi.stubEnv("XDG_DATA_HOME", "/tmp/synara-devin-acp-runtime-interactive-test");
    vi.stubEnv("APPDATA", "/tmp/synara-devin-acp-runtime-interactive-test");
    vi.stubEnv("WINDSURF_API_KEY", "");
    vi.stubEnv("DEVIN_API_KEY", "");
    vi.stubEnv("windsurf_api_key", "");

    try {
      await Effect.runPromise(
        makeDevinAcpRuntime({
          childProcessSpawner: {} as ChildProcessSpawner.ChildProcessSpawner["Service"],
          devinSettings: undefined,
          runtimeMode: "approval-required",
          cwd: "/tmp/project",
          clientInfo: { name: "Synara", version: "0.0.0" },
        }).pipe(Effect.scoped),
      );

      const error = await Effect.runPromise(
        capturedOptions!.validateInitializeResult!(
          initializeWithAuthMethods(["devin-browser"]),
        ).pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
      expect(error.message).toContain("will not open a browser during a message send");
      expect(error.message).toContain("Set WINDSURF_API_KEY or log in with Devin CLI");
    } finally {
      layerSpy.mockRestore();
      vi.unstubAllEnvs();
    }
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

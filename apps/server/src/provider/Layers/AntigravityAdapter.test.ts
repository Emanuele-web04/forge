import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderRuntimeEvent, ThreadId } from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import { AntigravityAdapter } from "../Services/AntigravityAdapter";
import {
  antigravityPromptCommandLineIssue,
  type AntigravityAdapterDependencies,
  buildAntigravityCaptureCommand,
  buildAntigravityHookConfig,
  buildAntigravityTurnProcessEnvironment,
  buildAntigravityTurnPrompt,
  ensureCapturePlugin,
  hookScriptSource,
  makeAntigravityRuntimeEventBase,
  makeAntigravityAdapterLive,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  readCompleteAntigravityLines,
  resolveAntigravityCliModelLabel,
  runAntigravityHelperProcess,
} from "./AntigravityAdapter";

function runCaptureCommand(command: string, input: string, env: NodeJS.ProcessEnv) {
  const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return spawnSync(shell, args, {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout: 5_000,
  });
}

type ControllableAntigravityChild = ChildProcess & {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
};

function makeControllableAntigravityChild(): ControllableAntigravityChild {
  const child = new EventEmitter() as ControllableAntigravityChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  return child;
}

function closeControllableAntigravityChild(
  child: ControllableAntigravityChild,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function makeGatewayCredentials(onRevoke: (token: string) => void): AgentGatewayCredentialsShape {
  let tokenSequence = 0;
  return {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: () => `test-session-${String(++tokenSequence)}`,
    verifySessionToken: () => null,
    verifySession: () => null,
    issueStdioBootstrapToken: (token) => `bootstrap-${token}`,
    exchangeStdioBootstrapToken: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    registerInFlightRequest: () => () => undefined,
    cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
    cancelSessionTurnRequests: () => Promise.resolve(),
    retireSessionTurn: () => Promise.resolve(),
    revokeSessionToken: onRevoke,
    connectionForThread: () => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `test-session-${String(++tokenSequence)}`,
    }),
    stdioProxy: { command: process.execPath, args: ["proxy.mjs"] },
  };
}

describe("Antigravity CLI model translation", () => {
  it("collapses CLI model/effort labels into base models with effort ladders", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`),
    ).toEqual([
      {
        slug: "Gemini 3.5 Flash",
        name: "Gemini 3.5 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.1 Pro",
        name: "Gemini 3.1 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "Claude Opus 4.6",
        name: "Claude Opus 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "GPT-OSS 120B",
        name: "GPT-OSS 120B",
        supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("rebuilds the exact CLI model label only at dispatch", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe(
      "Gemini 3.5 Flash (Low)",
    );
  });

  it("accepts bullet-prefixed model output", () => {
    expect(parseAntigravityCliModelLabel("* Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("• Claude Sonnet 4.6 (Thinking)")).toEqual({
      model: "Claude Sonnet 4.6",
      effort: "thinking",
    });
  });

  it("discovers future CLI models without requiring a static catalog update", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 4 Pro (Low)
Gemini 4 Pro (Ultra)
Claude Sonnet 5 (Thinking)
`),
    ).toEqual([
      {
        slug: "Gemini 4 Pro",
        name: "Gemini 4 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "ultra", label: "Ultra" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 5",
        name: "Claude Sonnet 5",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  it("dispatches a discovered model with its discovered default effort", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 4 Pro", undefined, "low")).toBe(
      "Gemini 4 Pro (Low)",
    );
  });
});

describe("Antigravity CLI integration helpers", () => {
  it("rotates the gateway lease per print turn and rejects a retained prior bootstrap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-turn-lease-"));
    const liveTokens = new Set<string>();
    const bootstrapOwners = new Map<string, string>();
    const revokedTokens: string[] = [];
    const spawnedEnvironments: NodeJS.ProcessEnv[] = [];
    let tokenSequence = 0;
    let bootstrapSequence = 0;
    const issueSessionToken = () => {
      const token = `turn-session-${String(++tokenSequence)}`;
      liveTokens.add(token);
      return token;
    };
    const credentials: AgentGatewayCredentialsShape = {
      mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
      setListeningPort: () => undefined,
      issueSessionToken: () => issueSessionToken(),
      verifySessionToken: (token) => (liveTokens.has(token) ? "thread-antigravity" : null),
      verifySession: () => null,
      issueStdioBootstrapToken: (sessionToken) => {
        if (!liveTokens.has(sessionToken)) return null;
        const bootstrap = `turn-bootstrap-${String(++bootstrapSequence)}`;
        bootstrapOwners.set(bootstrap, sessionToken);
        return bootstrap;
      },
      exchangeStdioBootstrapToken: (bootstrap) => {
        const owner = bootstrapOwners.get(bootstrap);
        bootstrapOwners.delete(bootstrap);
        return owner && liveTokens.has(owner) ? owner : null;
      },
      bindWriteAuthority: () => null,
      verifyWriteAuthority: () => false,
      registerInFlightRequest: () => () => undefined,
      cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
      cancelSessionTurnRequests: () => Promise.resolve(),
      retireSessionTurn: () => Promise.resolve(),
      revokeSessionToken: (token) => {
        liveTokens.delete(token);
        revokedTokens.push(token);
        for (const [bootstrap, owner] of bootstrapOwners) {
          if (owner === token) bootstrapOwners.delete(bootstrap);
        }
      },
      connectionForThread: () => ({
        url: "http://127.0.0.1:3773/mcp",
        bearerToken: issueSessionToken(),
      }),
      stdioProxy: { command: process.execPath, args: ["proxy.mjs"] },
    };
    let processSequence = 0;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      spawnedEnvironments.push(options.env ?? {});
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        pid: 10_000 + ++processSequence,
        stdout,
        stderr,
        killed: false,
        kill: () => true,
      });
      setTimeout(() => {
        stdout.end("done\n");
        stderr.end();
        child.emit("close", 0, null);
      }, 50).unref();
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-turn-lease");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const waitUntilReady = Effect.gen(function* () {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const session = (yield* adapter.listSessions()).find(
                (candidate) => candidate.threadId === threadId,
              );
              if (session?.status === "ready") return;
              yield* Effect.sleep(10);
            }
            throw new Error("Antigravity test turn did not settle.");
          });

          yield* adapter.sendTurn({ threadId, input: "turn A", attachments: [] });
          const bootstrapA = spawnedEnvironments[0]?.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN;
          expect(bootstrapA).toBe("turn-bootstrap-1");
          yield* waitUntilReady;
          expect(revokedTokens).toEqual(["turn-session-1"]);

          yield* adapter.sendTurn({ threadId, input: "turn B", attachments: [] });
          const bootstrapB = spawnedEnvironments[1]?.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN;
          expect(bootstrapB).toBe("turn-bootstrap-2");
          expect(credentials.exchangeStdioBootstrapToken(bootstrapA!)).toBeNull();
          expect(credentials.exchangeStdioBootstrapToken(bootstrapB!)).toBe("turn-session-2");
          yield* waitUntilReady;
          expect(revokedTokens).toEqual(["turn-session-1", "turn-session-2"]);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provide(Layer.succeed(AgentGatewayCredentials, credentials)),
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-turn-lease-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("installs the generated Synara MCP plugin alongside the capture hooks", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-home-test-"));
    const stdioProxy = {
      command: "/Applications/Synara.app/Contents/MacOS/Synara",
      args: ["/state/agent-gateway-mcp-proxy.mjs"],
    };
    const invocations: Array<{
      readonly command: string;
      readonly args: string[];
      readonly options: { cwd?: string; timeoutMs?: number };
    }> = [];
    try {
      await ensureCapturePlugin("/usr/local/bin/agy", stdioProxy, {
        homeDir,
        runHelper: async (command, args, options) => {
          if (options === undefined) {
            throw new Error("Expected plugin installation options.");
          }
          invocations.push({ command, args, options });
          return { stdout: "installed", stderr: "", code: 0 };
        },
      });

      const pluginDir = path.join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "plugins",
        "synara-capture",
      );
      expect(invocations).toEqual([
        {
          command: "/usr/local/bin/agy",
          args: ["plugin", "install", pluginDir],
          options: { timeoutMs: 30_000 },
        },
      ]);
      expect(
        JSON.parse(await fs.readFile(path.join(pluginDir, "mcp_config.json"), "utf8")),
      ).toEqual({
        mcpServers: {
          synara: {
            command: stdioProxy.command,
            args: stdioProxy.args,
            env: {
              SYNARA_AGENT_GATEWAY_URL: "$SYNARA_AGENT_GATEWAY_URL",
              SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "$SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
              ELECTRON_RUN_AS_NODE: "1",
            },
            disabled: false,
            disabledTools: [],
          },
        },
      });
      await expect(fs.readFile(path.join(pluginDir, "hooks.json"), "utf8")).resolves.toContain(
        "PreToolUse",
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("gives an Antigravity turn only its thread-scoped gateway credential", () => {
    const env = buildAntigravityTurnProcessEnvironment({
      eventFile: "/tmp/thread-a-hooks.ndjson",
      gatewayConnection: {
        url: "http://127.0.0.1:3773/mcp",
      },
      gatewayBootstrapToken: "thread-a-bootstrap",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        GEMINI_API_KEY: "gemini-key",
        SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:9999/stale",
        SYNARA_AGENT_GATEWAY_TOKEN: "stale-token",
        SYNARA_AUTH_TOKEN: "host-control-plane-token",
        SYNARA_BROWSER_HOST_PIPE_PATH: "/tmp/desktop.sock",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/legacy.sock",
        SYNARA_BROWSER_HOST_CAPABILITY: "desktop-capability",
        SYNARA_BROWSER_HOST_CAPABILITY_FD: "3",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/desktop.sock",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GEMINI_API_KEY: "gemini-key",
      SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:3773/mcp",
      SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "thread-a-bootstrap",
      SYNARA_ANTIGRAVITY_EVENTS: "/tmp/thread-a-hooks.ndjson",
      SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
    });
  });

  it("advertises canonical browser tools only while the session owns a gateway lease", () => {
    const withLease = {};
    const autonomousPrompt = buildAntigravityTurnPrompt(withLease, {
      prompt: "Ouvre YouTube dans le navigateur intégré.",
      hasGatewaySessionLease: true,
    });
    expect(autonomousPrompt).toContain("Use the browser_* tools autonomously");
    expect(autonomousPrompt).toContain("browser_open");
    expect(autonomousPrompt).toContain("Ouvre YouTube dans le navigateur intégré.");
    expect(
      buildAntigravityTurnPrompt(withLease, {
        prompt: "Continue.",
        hasGatewaySessionLease: true,
      }),
    ).toBe("Continue.");

    const withoutLease = {};
    const identityOnlyPrompt = buildAntigravityTurnPrompt(withoutLease, {
      prompt: "Ouvre YouTube dans le navigateur intégré.",
      hasGatewaySessionLease: false,
    });
    expect(identityOnlyPrompt).not.toContain("browser_*");
    expect(identityOnlyPrompt).toContain("Synara MCP control is unavailable");

    const envWithoutLease = buildAntigravityTurnProcessEnvironment({
      eventFile: "/tmp/thread-b-hooks.ndjson",
      baseEnv: {
        SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:9999/stale",
        SYNARA_AGENT_GATEWAY_TOKEN: "stale-token",
        SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "stale-bootstrap",
      },
    });
    expect(envWithoutLease.SYNARA_AGENT_GATEWAY_URL).toBeUndefined();
    expect(envWithoutLease.SYNARA_AGENT_GATEWAY_TOKEN).toBeUndefined();
    expect(envWithoutLease.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN).toBeUndefined();
  });

  it("propagates the owning lifecycle generation into runtime events", () => {
    expect(
      makeAntigravityRuntimeEventBase({
        threadId: "thread-antigravity-lifecycle" as never,
        lifecycleGeneration: "generation-1",
        eventId: "event-1" as never,
        createdAt: "2026-07-17T00:00:00.000Z",
      }),
    ).toMatchObject({
      provider: "antigravity",
      threadId: "thread-antigravity-lifecycle",
      lifecycleGeneration: "generation-1",
      eventId: "event-1",
      createdAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("keeps the globally installed hook neutral outside Synara sessions", () => {
    const command = buildAntigravityCaptureCommand(
      "__synara_gui_must_not_launch__",
      "__capture_script_must_not_run__",
      "pre-tool",
    );
    const result = runCaptureCommand(
      command,
      // Stay below platform pipe-buffer limits: spawnSync itself can deadlock
      // while writing multi-megabyte stdin on macOS, which tests Node rather
      // than the hook's simple drain-and-return behavior.
      JSON.stringify({ payload: "x".repeat(32 * 1024) }),
      { SYNARA_ANTIGRAVITY_EVENTS: "" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Neutral for PreToolUse means preserving the permission flow: Antigravity
    // requires a `decision`, and an empty object is treated as a denial with
    // an empty reason that blocks every tool call (#490).
    expect(result.stdout.trim()).toBe('{"decision":"ask"}');

    const postToolResult = runCaptureCommand(
      buildAntigravityCaptureCommand(
        "__synara_gui_must_not_launch__",
        "__capture_script_must_not_run__",
        "post-tool",
      ),
      JSON.stringify({ payload: "x" }),
      { SYNARA_ANTIGRAVITY_EVENTS: "" },
    );
    expect(postToolResult.error).toBeUndefined();
    expect(postToolResult.status).toBe(0);
    expect(postToolResult.stdout.trim()).toBe("{}");
  });

  it("answers pre-tool with a decision from the capture script when capture is inactive", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      // Invoke the script directly, bypassing the shell wrapper: its inactive
      // fallback is defense in depth for a caller that runs the script without
      // a capture target, and must answer PreToolUse with a decision too.
      const result = spawnSync(process.execPath, [scriptPath, "pre-tool"], {
        env: { ...process.env, SYNARA_ANTIGRAVITY_EVENTS: "" },
        input: JSON.stringify({ tool: "shell" }),
        encoding: "utf8",
        timeout: 5_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"ask"}');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("runs the capture script for Synara-managed sessions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      const command = buildAntigravityCaptureCommand(process.execPath, scriptPath, "pre-tool");
      const payload = JSON.stringify({ tool: "shell" });
      const result = runCaptureCommand(command, payload, {
        SYNARA_ANTIGRAVITY_EVENTS: eventPath,
        SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
      expect(await fs.readFile(eventPath, "utf8")).toBe(`pre-tool\t${payload}\n`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("runs packaged Electron as Node only for Synara-managed sessions", () => {
    expect(
      buildAntigravityCaptureCommand(
        "/Applications/Synara.app/Contents/MacOS/Synara",
        "/tmp/synara-capture/capture.cjs",
        "pre-tool",
        "darwin",
      ),
    ).toBe(
      `if [ -z "\${SYNARA_ANTIGRAVITY_EVENTS:-}" ]; then cat >/dev/null 2>&1 || :; printf '%s\\n' '{"decision":"ask"}'; else ELECTRON_RUN_AS_NODE=1 '/Applications/Synara.app/Contents/MacOS/Synara' '/tmp/synara-capture/capture.cjs' 'pre-tool'; fi`,
    );
    expect(
      buildAntigravityCaptureCommand(
        String.raw`C:\Program Files\Synara\Synara.exe`,
        String.raw`C:\Users\test\.gemini\capture.cjs`,
        "pre-tool",
        "win32",
      ),
    ).toBe(
      String.raw`if not defined SYNARA_ANTIGRAVITY_EVENTS (more >nul 2>nul & echo {"decision":"ask"}) else (set "ELECTRON_RUN_AS_NODE=1" && "C:\Program Files\Synara\Synara.exe" "C:\Users\test\.gemini\capture.cjs" "pre-tool")`,
    );
  });

  it("guards Windows command-line limits before spawning the CLI", () => {
    expect(antigravityPromptCommandLineIssue("x".repeat(24_000), "win32")).toBeNull();
    expect(antigravityPromptCommandLineIssue("x".repeat(24_001), "win32")).toContain(
      "limited to 24,000 characters",
    );
    expect(antigravityPromptCommandLineIssue("x".repeat(120_000), "darwin")).toBeNull();
  });

  it("marks every generated hook as a command hook", () => {
    expect(buildAntigravityHookConfig((event) => `capture ${event}`)).toEqual({
      "synara-capture": {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture pre-tool" }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture post-tool" }],
          },
        ],
        PreInvocation: [{ type: "command", command: "capture pre-invocation" }],
        PostInvocation: [{ type: "command", command: "capture post-invocation" }],
        Stop: [{ type: "command", command: "capture stop" }],
      },
    });
  });

  it("advances file offsets only past complete JSONL records", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-test-"));
    const file = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(file, '{"first":true}\n{"second"');
      const first = await readCompleteAntigravityLines(file, 0);
      expect(first).toEqual({ lines: ['{"first":true}'], nextOffset: 15 });

      await fs.appendFile(file, ":true}\n");
      const second = await readCompleteAntigravityLines(file, first.nextOffset);
      expect(second).toEqual({ lines: ['{"second":true}'], nextOffset: 31 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates helper processes that exceed their timeout", async () => {
    await expect(
      runAntigravityHelperProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Antigravity helper timed out after 50ms");
  });

  // #465: an active Stop hook must not emit a non-standard decision that can
  // hang the print process after the assistant reply is already visible.
  it("answers stop hooks with a neutral allow-exit payload", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-hook-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      const result = spawnSync(process.execPath, [scriptPath, "stop"], {
        env: { ...process.env, SYNARA_ANTIGRAVITY_EVENTS: eventPath },
        input: JSON.stringify({ stop: true }),
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
      expect(result.stdout).not.toContain('"decision":"stop"');
      expect(await fs.readFile(eventPath, "utf8")).toContain("stop\t");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Antigravity turn settle on cancel (#465)", () => {
  it("keeps an unproven process active and blocks a successor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-interrupt-hung-"));
    let teardownShouldFail = true;
    const child = makeControllableAntigravityChild();
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv },
    ) => child) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      if (teardownShouldFail) throw new Error("process exit remains unproven");
      return { escalated: false, signalErrors: [] };
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-interrupt-hung");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "stuck working",
            attachments: [],
          });
          const before = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
          expect(before?.status).toBe("running");
          expect(before?.activeTurnId).toBe(turn.turnId);

          yield* adapter.interruptTurn(threadId, turn.turnId);

          const after = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
          expect(after?.status).toBe("running");
          expect(after?.activeTurnId).toBe(turn.turnId);
          yield* adapter.sendTurn({ threadId, input: "must remain blocked", attachments: [] }).pipe(
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() => expect(error.message).toContain("already active")),
            ),
          );
          teardownShouldFail = false;
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-interrupt-hung-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drains final output before settling a successfully interrupted process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-close-drain-"));
    const child = makeControllableAntigravityChild();
    let resolveTreeExit!: (result: { escalated: boolean; signalErrors: Error[] }) => void;
    const treeExit = new Promise<{ escalated: boolean; signalErrors: Error[] }>((resolve) => {
      resolveTreeExit = resolve;
    });
    const spawnProcess = (() => child) as NonNullable<
      AntigravityAdapterDependencies["spawnProcess"]
    >;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      setTimeout(() => {
        child.stdout.end("final output before close\n");
        child.stderr.end();
        closeControllableAntigravityChild(child, null, "SIGTERM");
      }, 10);
      setTimeout(() => resolveTreeExit({ escalated: false, signalErrors: [] }), 30);
      return treeExit;
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const runtimeEventsFiber = yield* Stream.runCollect(
            Stream.take(adapter.streamEvents, 7),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("thread-antigravity-close-drain");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "cancel after output",
            attachments: [],
          });
          yield* adapter.interruptTurn(threadId, turn.turnId);

          const runtimeEvents = Array.from(
            yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("5 seconds")),
          );
          expect(
            runtimeEvents
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta),
          ).toEqual(["final output before close"]);
          const completed = runtimeEvents.find((event) => event.type === "turn.completed");
          expect(completed?.turnId).toBe(turn.turnId);
          expect(completed?.payload).toMatchObject({
            state: "interrupted",
            stopReason: "interrupted",
          });
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 100,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-close-drain-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps interrupt ownership when root closes before tree-exit proof fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-interrupt-proof-"));
    const child = makeControllableAntigravityChild();
    const spawnProcess = (() => child) as NonNullable<
      AntigravityAdapterDependencies["spawnProcess"]
    >;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      setTimeout(() => {
        child.stdout.end("output before failed proof\n");
        child.stderr.end();
        closeControllableAntigravityChild(child, null, "SIGTERM");
      }, 10);
      await new Promise((_, reject) =>
        setTimeout(() => reject(new Error("interrupt descendants remain alive")), 30),
      );
      return { escalated: false, signalErrors: [] };
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-interrupt-proof");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "cancel with surviving descendants",
            attachments: [],
          });
          yield* adapter.interruptTurn(threadId, turn.turnId);

          const afterFailedProof = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(afterFailedProof?.status).toBe("running");
          expect(afterFailedProof?.activeTurnId).toBe(turn.turnId);
          yield* adapter.sendTurn({ threadId, input: "must remain blocked", attachments: [] }).pipe(
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() => expect(error.message).toContain("already active")),
            ),
          );
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 100,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-interrupt-proof-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a Stop-hook teardown as model completion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-model-stop-"));
    const child = makeControllableAntigravityChild();
    let eventFile = "";
    let teardownStarted = false;
    let resolveTreeExit!: (result: { escalated: boolean; signalErrors: Error[] }) => void;
    const treeExit = new Promise<{ escalated: boolean; signalErrors: Error[] }>((resolve) => {
      resolveTreeExit = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS ?? "";
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      teardownStarted = true;
      return treeExit;
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const runtimeEventsFiber = yield* Stream.runCollect(
            Stream.take(adapter.streamEvents, 7),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("thread-antigravity-model-stop");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "finish normally",
            attachments: [],
          });
          yield* Effect.promise(() => fs.appendFile(eventFile, "stop\t{}\n"));
          for (let attempt = 0; attempt < 20 && !teardownStarted; attempt += 1) {
            yield* Effect.sleep(10);
          }
          expect(teardownStarted).toBe(true);
          child.stdout.end("completed response\n");
          child.stderr.end();
          closeControllableAntigravityChild(child, null, "SIGTERM");
          yield* Effect.sleep(20);

          const beforeTreeExitProof = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(beforeTreeExitProof?.status).toBe("running");
          expect(beforeTreeExitProof?.activeTurnId).toBe(turn.turnId);
          resolveTreeExit({ escalated: false, signalErrors: [] });

          const runtimeEvents = Array.from(
            yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("5 seconds")),
          );
          const completed = runtimeEvents.find((event) => event.type === "turn.completed");
          expect(completed?.turnId).toBe(turn.turnId);
          expect(completed?.payload).toMatchObject({
            state: "completed",
            stopReason: "model_stop",
          });
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 100,
              stopNaturalExitGraceMs: 10,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-model-stop-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retains ownership when Stop teardown cannot prove descendant exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-unproven-"));
    const child = makeControllableAntigravityChild();
    let eventFile = "";
    let teardownCalls = 0;
    let rejectTreeExit!: (cause: unknown) => void;
    const treeExit = new Promise<never>((_resolve, reject) => {
      rejectTreeExit = reject;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS ?? "";
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      teardownCalls += 1;
      if (teardownCalls === 1) return treeExit;
      return { escalated: false, signalErrors: [] };
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stop-unproven");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "finish with surviving descendants",
            attachments: [],
          });
          yield* Effect.promise(() => fs.appendFile(eventFile, "stop\t{}\n"));
          for (let attempt = 0; attempt < 20 && teardownCalls === 0; attempt += 1) {
            yield* Effect.sleep(10);
          }
          expect(teardownCalls).toBe(1);
          child.stdout.end("root response\n");
          child.stderr.end();
          closeControllableAntigravityChild(child, null, "SIGTERM");
          rejectTreeExit(new Error("descendant exit remains unproven"));
          yield* Effect.sleep(20);

          const afterFailedProof = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(afterFailedProof?.status).toBe("running");
          expect(afterFailedProof?.activeTurnId).toBe(turn.turnId);
          yield* adapter.sendTurn({ threadId, input: "must remain blocked", attachments: [] }).pipe(
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() => expect(error.message).toContain("already active")),
            ),
          );
          yield* adapter.stopSession(threadId).pipe(
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() =>
                expect(error.message).toContain("descendant exit remains unproven"),
              ),
            ),
          );
          expect(teardownCalls).toBe(1);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 100,
              stopNaturalExitGraceMs: 10,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-stop-unproven-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not start teardown from a Stop hook discovered after root close", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-short-close-"));
    const child = makeControllableAntigravityChild();
    let eventFile = "";
    let teardownCalls = 0;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS ?? "";
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      teardownCalls += 1;
      return { escalated: false, signalErrors: [] };
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const runtimeEventsFiber = yield* Stream.runCollect(
            Stream.take(adapter.streamEvents, 7),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("thread-antigravity-short-close");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "short successful turn",
            attachments: [],
          });
          yield* Effect.promise(() => fs.appendFile(eventFile, "stop\t{}\n"));
          yield* Effect.sleep(20);
          expect(teardownCalls).toBe(0);
          child.stdout.end("short response\n");
          child.stderr.end();
          closeControllableAntigravityChild(child, 0, null);

          const runtimeEvents = Array.from(
            yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("5 seconds")),
          );
          expect(teardownCalls).toBe(0);
          const completed = runtimeEvents.find((event) => event.type === "turn.completed");
          expect(completed?.turnId).toBe(turn.turnId);
          expect(completed?.payload).toMatchObject({
            state: "completed",
            stopReason: "model_stop",
          });
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              stopNaturalExitGraceMs: 100,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-short-close-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans turn resources before Stop close-drain timeout settlement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-timeout-"));
    const child = makeControllableAntigravityChild();
    const revokedTokens: string[] = [];
    const credentials = makeGatewayCredentials((token) => revokedTokens.push(token));
    let eventFile = "";
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS ?? "";
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => ({ escalated: false, signalErrors: [] });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stop-timeout");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({
            threadId,
            input: "stop without close",
            attachments: [],
          });
          const runDir = path.dirname(eventFile);
          yield* Effect.promise(() => fs.appendFile(eventFile, "stop\t{}\n"));
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const session = (yield* adapter.listSessions()).find(
              (candidate) => candidate.threadId === threadId,
            );
            if (session?.status === "ready") break;
            yield* Effect.sleep(10);
          }

          const settled = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(settled?.status).toBe("ready");
          expect(revokedTokens).toEqual(["test-session-1"]);
          yield* Effect.promise(() =>
            fs.stat(runDir).then(
              () => expect.fail("expected the completed turn run directory to be removed"),
              (error: NodeJS.ErrnoException) => expect(error.code).toBe("ENOENT"),
            ),
          );
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 25,
              stopNaturalExitGraceMs: 10,
            }).pipe(
              Layer.provide(Layer.succeed(AgentGatewayCredentials, credentials)),
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-stop-timeout-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not settle a detached Stop timeout after session removal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-session-"));
    const child = makeControllableAntigravityChild();
    let eventFile = "";
    let teardownCalls = 0;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS ?? "";
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => {
      teardownCalls += 1;
      return { escalated: false, signalErrors: [] };
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const runtimeEvents: ProviderRuntimeEvent[] = [];
          const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => runtimeEvents.push(event)),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stop-session");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({
            threadId,
            input: "stop session during timeout",
            attachments: [],
          });
          yield* Effect.promise(() => fs.appendFile(eventFile, "stop\t{}\n"));
          for (let attempt = 0; attempt < 30 && teardownCalls === 0; attempt += 1) {
            yield* Effect.sleep(10);
          }
          expect(teardownCalls).toBe(1);
          yield* adapter.stopSession(threadId);
          yield* Effect.sleep(150);
          yield* Fiber.interrupt(runtimeEventsFiber);

          expect(runtimeEvents.map((event) => event.type)).toEqual([
            "session.started",
            "thread.started",
            "turn.started",
            "session.exited",
          ]);
          expect(runtimeEvents.some((event) => event.type === "turn.completed")).toBe(false);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 100,
              stopNaturalExitGraceMs: 10,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-stop-session-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a stale child contaminate or settle the follow-up turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stale-child-"));
    const children: ControllableAntigravityChild[] = [];
    const eventFiles: string[] = [];
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      const child = makeControllableAntigravityChild();
      children.push(child);
      eventFiles.push(options.env?.SYNARA_ANTIGRAVITY_EVENTS ?? "");
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const teardownProcessTree: NonNullable<
      AntigravityAdapterDependencies["teardownProcessTree"]
    > = async () => ({ escalated: false, signalErrors: [] });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const runtimeEventsFiber = yield* Stream.runCollect(
            Stream.take(adapter.streamEvents, 9),
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stale-child");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });

          const firstTurn = yield* adapter.sendTurn({
            threadId,
            input: "first turn",
            attachments: [],
          });
          yield* adapter.interruptTurn(threadId, firstTurn.turnId);

          const secondTurn = yield* adapter.sendTurn({
            threadId,
            input: "follow-up turn",
            attachments: [],
          });
          const firstChild = children[0]!;
          const secondChild = children[1]!;
          yield* Effect.promise(() =>
            fs.stat(path.dirname(eventFiles[0]!)).then(
              () => expect.fail("expected the interrupted turn run directory to be removed"),
              (error: NodeJS.ErrnoException) => expect(error.code).toBe("ENOENT"),
            ),
          );
          firstChild.stdout.write("stale first-turn output\n");
          closeControllableAntigravityChild(firstChild, 0, null);
          yield* Effect.sleep(100);

          const afterStaleClose = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(afterStaleClose?.status).toBe("running");
          expect(afterStaleClose?.activeTurnId).toBe(secondTurn.turnId);

          secondChild.stdout.end("fresh follow-up output\n");
          secondChild.stderr.end();
          closeControllableAntigravityChild(secondChild, 0, null);

          const runtimeEvents = Array.from(
            yield* Fiber.join(runtimeEventsFiber).pipe(Effect.timeout("5 seconds")),
          );
          const completed = runtimeEvents.filter((event) => event.type === "turn.completed");
          expect(
            completed.map((event) => ({ turnId: event.turnId, state: event.payload.state })),
          ).toEqual([
            { turnId: firstTurn.turnId, state: "interrupted" },
            { turnId: secondTurn.turnId, state: "completed" },
          ]);
          expect(
            runtimeEvents
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta),
          ).toEqual(["fresh follow-up output"]);
          expect(
            runtimeEvents.some(
              (event) => event.providerRefs?.providerThreadId === "stale-conversation",
            ),
          ).toBe(false);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree,
              closeDrainTimeoutMs: 25,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-stale-child-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
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
  detectAntigravityBackgroundTaskStart,
  ensureCapturePlugin,
  hookScriptSource,
  makeAntigravityRuntimeEventBase,
  makeAntigravityAdapterLive,
  matchAntigravityTrackedTaskId,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  parseAntigravitySystemMessage,
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
    ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
  });
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

  it("collapses tab-separated slug/label rows from newer agy models output", () => {
    expect(
      parseAntigravityModelLines(`
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`),
    ).toEqual([
      {
        slug: "Gemini 3.6 Flash",
        name: "Gemini 3.6 Flash",
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
    ]);
  });

  it("rebuilds the exact CLI model label only at dispatch", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toEqual(
      {
        model: "Gemini 3.6 Flash",
        effort: "high",
      },
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe(
      "Gemini 3.5 Flash (Low)",
    );
    expect(resolveAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toBe(
      "Gemini 3.6 Flash (High)",
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
          options: { timeoutMs: 45_000 },
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

    // PreInvocation gates the upcoming LLM invocation (the subagent's first
    // model call when the agent spawns one): an empty object is treated as a
    // denial that aborts the launch and makes the parent CLI exit with
    // code 1, so the inactive hook must answer allow.
    const preInvocationResult = runCaptureCommand(
      buildAntigravityCaptureCommand(
        "__synara_gui_must_not_launch__",
        "__capture_script_must_not_run__",
        "pre-invocation",
      ),
      JSON.stringify({ payload: "x" }),
      { SYNARA_ANTIGRAVITY_EVENTS: "" },
    );
    expect(preInvocationResult.error).toBeUndefined();
    expect(preInvocationResult.status).toBe(0);
    expect(preInvocationResult.stdout.trim()).toBe('{"decision":"allow"}');
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
      const payload = JSON.stringify({
        stepIdx: 12,
        conversationId: "conversation-1",
        transcriptPath: "/tmp/transcript.jsonl",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo super-secret-token" },
        },
      });
      const result = runCaptureCommand(command, payload, {
        SYNARA_ANTIGRAVITY_EVENTS: eventPath,
        SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
      const captured = await fs.readFile(eventPath, "utf8");
      expect(captured).toBe(
        'pre-tool\t{"conversationId":"conversation-1","transcriptPath":"/tmp/transcript.jsonl","stepIdx":12,"toolCall":{"name":"run_command","args":{"CommandLine":"echo super-secret-token"}}}\n',
      );
      expect(captured).toContain("super-secret-token");
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
        String.raw`C:\Users\test\AppData\Local\Programs\Synara\Synara.exe`,
        String.raw`C:\Users\test\.gemini\capture.cjs`,
        "pre-tool",
        "win32",
      ),
    ).toBe(
      // The Antigravity CLI runs hook commands through cmd.exe with JSON
      // escapes intact, so `"` arrives as `\"` and quoted paths fail to
      // execute ("not recognized as an internal or external command"). The
      // win32 command must stay free of double quotes.
      String.raw`if not defined SYNARA_ANTIGRAVITY_EVENTS (more >nul 2>nul & echo {"decision":"ask"}) else (set ELECTRON_RUN_AS_NODE=1&& C:\Users\test\AppData\Local\Programs\Synara\Synara.exe C:\Users\test\.gemini\capture.cjs pre-tool)`,
    );
    // PreInvocation gates the LLM invocation: answer allow so subagent
    // launches are not denied (which would make the parent CLI exit 1).
    expect(
      buildAntigravityCaptureCommand(
        String.raw`C:\Users\test\AppData\Local\Programs\Synara\Synara.exe`,
        String.raw`C:\Users\test\.gemini\capture.cjs`,
        "pre-invocation",
        "win32",
      ),
    ).toBe(
      String.raw`if not defined SYNARA_ANTIGRAVITY_EVENTS (more >nul 2>nul & echo {"decision":"allow"}) else (set ELECTRON_RUN_AS_NODE=1&& C:\Users\test\AppData\Local\Programs\Synara\Synara.exe C:\Users\test\.gemini\capture.cjs pre-invocation)`,
    );
    expect(
      buildAntigravityCaptureCommand(
        "/Applications/Synara.app/Contents/MacOS/Synara",
        "/tmp/synara-capture/capture.cjs",
        "pre-invocation",
        "darwin",
      ),
    ).toBe(
      `if [ -z "\${SYNARA_ANTIGRAVITY_EVENTS:-}" ]; then cat >/dev/null 2>&1 || :; printf '%s\\n' '{"decision":"allow"}'; else ELECTRON_RUN_AS_NODE=1 '/Applications/Synara.app/Contents/MacOS/Synara' '/tmp/synara-capture/capture.cjs' 'pre-invocation'; fi`,
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

  it("streams hook tool names and terminal states with arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-tool-events-"));
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const toolEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "item.started" || event.type === "item.completed",
            ),
            Stream.take(4),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-tool-events");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "exercise tools",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'pre-tool\t{"stepIdx":7,"toolCall":{"name":"run_command","args":{"token":"super-secret-token"}}}',
                'post-tool\t{"stepIdx":7,"error":"super-secret-error"}',
                'pre-tool\t{"stepIdx":8,"toolCall":{"name":"write_to_file","args":{"content":"super-secret-content"}}}',
                'post-tool\t{"stepIdx":8,"error":""}',
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(toolEventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(events).toHaveLength(4);
          expect(events.map((event) => event.type)).toEqual([
            "item.started",
            "item.completed",
            "item.started",
            "item.completed",
          ]);
          expect(events.map((event) => event.payload)).toEqual([
            {
              itemType: "command_execution",
              status: "inProgress",
              title: "run_command",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-0`,
                toolName: "run_command",
                arguments: { token: "super-secret-token" },
                input: { token: "super-secret-token" },
                rawInput: { token: "super-secret-token" },
              },
            },
            {
              itemType: "command_execution",
              status: "failed",
              title: "run_command",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-0`,
                toolName: "run_command",
                arguments: { token: "super-secret-token" },
                input: { token: "super-secret-token" },
                rawInput: { token: "super-secret-token" },
                rawOutput: "super-secret-error",
              },
            },
            {
              itemType: "file_change",
              status: "inProgress",
              title: "write_to_file",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-1`,
                toolName: "write_to_file",
                arguments: { content: "super-secret-content" },
                input: { content: "super-secret-content" },
                rawInput: { content: "super-secret-content" },
              },
            },
            {
              itemType: "file_change",
              status: "completed",
              title: "write_to_file",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-1`,
                toolName: "write_to_file",
                arguments: { content: "super-secret-content" },
                input: { content: "super-secret-content" },
                rawInput: { content: "super-secret-content" },
                rawOutput: "",
              },
            },
          ]);

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-tool-events-" }),
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

  it("dedupes hook and transcript copies without collapsing repeated tool names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-tool-dedup-"));
    const transcriptDir = path.join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      "conv-dedup-1",
      ".system_generated",
      "logs",
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const toolEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "item.started" || event.type === "item.completed",
            ),
            Stream.take(4),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-tool-dedup");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "run a command",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();

          // Both sources report two run_command calls in the same planner step.
          // Each real call must render once, without either duplicating the
          // hook/transcript copy or collapsing the repeated tool name.
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                `pre-invocation\t${JSON.stringify({
                  conversationId: "conv-dedup-1",
                  transcriptPath: transcriptFile,
                })}`,
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"echo first"}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command"},"error":""}',
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"echo second"}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command"},"error":""}',
                "",
              ].join("\n"),
            ),
          );
          yield* Effect.promise(() =>
            fs.appendFile(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 1,
                  type: "PLANNER_RESPONSE",
                  thinking: "planning",
                  tool_calls: [
                    { name: "run_command", args: { CommandLine: "echo first" } },
                    { name: "run_command", args: { CommandLine: "echo second" } },
                  ],
                }),
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(toolEventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(events).toHaveLength(4);
          expect(events.map((event) => event.type)).toEqual([
            "item.started",
            "item.completed",
            "item.started",
            "item.completed",
          ]);
          const comparable = events.map((event) => ({
            type: event.type,
            itemType: event.payload.itemType,
            title: event.payload.title,
            toolCallId: (event.payload.data as { toolCallId?: string })?.toolCallId,
          }));
          expect(comparable).toEqual([
            {
              type: "item.started",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-0`,
            },
            {
              type: "item.completed",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-0`,
            },
            {
              type: "item.started",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-1`,
            },
            {
              type: "item.completed",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-1`,
            },
          ]);

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-tool-dedup-" }),
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

  it("routes subagent hook events to a child thread without rebinding the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-subagent-events-"));
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) =>
                event.type === "item.started" &&
                event.providerRefs?.providerThreadId === "conv-parent-1",
            ),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-subagent-events");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            resumeCursor: { conversationId: "conv-parent-1" },
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "spawn a subagent",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();

          // The subagent CLI inherits SYNARA_ANTIGRAVITY_EVENTS, so its hooks
          // land in this session's stream with the subagent's conversation id.
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                `pre-invocation\t${JSON.stringify({
                  conversationId: "conv-child-1",
                  transcriptPath: "C:/tmp/child-transcript.jsonl",
                  modelName: "gemini-3.6-flash-medium",
                })}`,
                `pre-tool\t${JSON.stringify({
                  conversationId: "conv-child-1",
                  stepIdx: 1,
                  toolCall: { name: "run_command", args: { CommandLine: "echo child" } },
                })}`,
                `post-tool\t${JSON.stringify({
                  conversationId: "conv-child-1",
                  stepIdx: 1,
                  error: "",
                })}`,
                `stop\t${JSON.stringify({ conversationId: "conv-child-1" })}`,
                `stop\t${JSON.stringify({ conversationId: "conv-child-1" })}`,
                `pre-tool\t${JSON.stringify({
                  conversationId: "conv-parent-1",
                  stepIdx: 2,
                  toolCall: { name: "run_command", args: { CommandLine: "echo parent" } },
                })}`,
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          const childRefs = {
            providerThreadId: "conv-child-1",
            providerParentThreadId: "conv-parent-1",
          };
          const childThreadStarted = events.find(
            (event) =>
              event.type === "thread.started" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childThreadStarted?.providerRefs).toEqual(childRefs);
          const childTurnStarted = events.find(
            (event) =>
              event.type === "turn.started" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childTurnStarted?.turnId).toBe(turn.turnId);
          expect(childTurnStarted?.payload).toMatchObject({ model: "gemini-3.6-flash-medium" });
          const childItemStarted = events.find(
            (event) =>
              event.type === "item.started" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childItemStarted?.providerRefs).toEqual(childRefs);
          expect(childItemStarted?.payload).toMatchObject({
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
          });
          const childItemCompleted = events.find(
            (event) =>
              event.type === "item.completed" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childItemCompleted?.payload).toMatchObject({
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
          });
          const childTurnCompleted = events.find(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childTurnCompleted?.payload).toEqual({
            state: "completed",
            stopReason: "model_stop",
          });
          expect(
            events.filter(
              (event) =>
                event.type === "turn.completed" &&
                event.providerRefs?.providerThreadId === "conv-child-1",
            ),
          ).toHaveLength(1);
          // The parent thread must not be re-emitted for the subagent, and the
          // session keeps its own conversation: its own tool events stay bound
          // to conv-parent-1 without a parent ref.
          expect(
            events.filter(
              (event) =>
                event.type === "thread.started" &&
                event.providerRefs?.providerThreadId === "conv-parent-1",
            ),
          ).toHaveLength(1);
          const parentItem = events.find(
            (event) =>
              event.type === "item.started" &&
              event.providerRefs?.providerThreadId === "conv-parent-1",
          );
          expect(parentItem?.providerRefs).toEqual({ providerThreadId: "conv-parent-1" });
          expect(parentItem?.payload).toMatchObject({ title: "run_command" });

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-subagent-events-" }),
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

  it("settles an unfinished child turn when the parent process fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-child-failure-"));
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) =>
                event.type === "turn.completed" &&
                event.providerRefs?.providerParentThreadId === undefined,
            ),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-child-failure");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            resumeCursor: { conversationId: "conv-parent-failure" },
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({
            threadId,
            input: "spawn a failing subagent",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();

          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conv-child-failure",
                modelName: "gemini-3.6-flash-medium",
              })}\n`,
            ),
          );
          child?.emit("close", 1, null);

          const events = Array.from(
            yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          const childTerminalIndex = events.findIndex(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerThreadId === "conv-child-failure",
          );
          const parentTerminalIndex = events.findIndex(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerParentThreadId === undefined,
          );
          expect(childTerminalIndex).toBeGreaterThanOrEqual(0);
          expect(childTerminalIndex).toBeLessThan(parentTerminalIndex);
          expect(events[childTerminalIndex]?.payload).toMatchObject({
            state: "failed",
            stopReason: "error",
          });
          expect(
            events.filter(
              (event) =>
                event.type === "turn.completed" &&
                event.providerRefs?.providerThreadId === "conv-child-failure",
            ),
          ).toHaveLength(1);

          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-child-failure-" }),
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
  const makeSpawnProcess = (children: ChildProcess[]) =>
    ((
      _command: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdout,
        stderr,
        killed: false,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      children.push(child);
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

  const failTeardown = async () => {
    throw new Error("process exit could not be proven");
  };

  it("unlocks Cancel without letting a late close settle the follow-up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-interrupt-hung-"));
    const children: ChildProcess[] = [];
    const spawnProcess = makeSpawnProcess(children);

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
          expect(after?.status).toBe("ready");
          expect(after?.activeTurnId).toBeUndefined();

          const followUp = yield* adapter.sendTurn({
            threadId,
            input: "follow-up",
            attachments: [],
          });
          children[0]?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");

          const afterLateClose = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(afterLateClose?.status).toBe("running");
          expect(afterLateClose?.activeTurnId).toBe(followUp.turnId);

          children[1]?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: failTeardown,
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

  it("emits a terminal interrupted turn.completed so the stop button unlocks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-button-"));
    const children: ChildProcess[] = [];
    const spawnProcess = makeSpawnProcess(children);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stop-button");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "long running work",
            attachments: [],
          });

          const terminalFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );

          // The UI's Stop button dispatches thread.turn.interrupt, which lands
          // on interruptTurn. It must settle the live turn terminal so the
          // projection flips the session back to ready and the button clears.
          yield* adapter.interruptTurn(threadId, turn.turnId);

          const terminal = Array.from(
            yield* Fiber.join(terminalFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(terminal).toHaveLength(1);
          expect(terminal[0]?.turnId).toBe(turn.turnId);
          expect(terminal[0]?.payload).toMatchObject({
            state: "interrupted",
            stopReason: "interrupted",
          });

          children[0]?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-stop-button-" }),
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

  it("resolves default reasoning effort for Gemini 3.7 Flash and DeepSeek models", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 3.7 Flash")).toBe("Gemini 3.7 Flash (High)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.7 Flash", { reasoningEffort: "medium" })).toBe(
      "Gemini 3.7 Flash (Medium)",
    );
    expect(resolveAntigravityCliModelLabel("DeepSeek V4 Flash Max")).toBe(
      "DeepSeek V4 Flash Max (High)",
    );
  });

  it("compacts multiline pre-invocation and stop hook payloads into single NDJSON lines", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-compact-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      const multilinePayload = JSON.stringify(
        {
          conversationId: "conv-123",
          transcriptPath: "C:\\path\\to\\transcript.jsonl",
          modelName: "Gemini 3.7 Flash",
          workspacePaths: ["C:\\workspace"],
        },
        null,
        2,
      );

      const preInvResult = runCaptureCommand(
        buildAntigravityCaptureCommand(process.execPath, scriptPath, "pre-invocation"),
        multilinePayload,
        { SYNARA_ANTIGRAVITY_EVENTS: eventPath },
      );
      expect(preInvResult.status).toBe(0);

      const stopResult = runCaptureCommand(
        buildAntigravityCaptureCommand(process.execPath, scriptPath, "stop"),
        multilinePayload,
        { SYNARA_ANTIGRAVITY_EVENTS: eventPath },
      );
      expect(stopResult.status).toBe(0);

      const fileContent = await fs.readFile(eventPath, "utf8");
      const lines = fileContent.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.startsWith("pre-invocation\t{")).toBe(true);
      expect(lines[1]?.startsWith("stop\t{")).toBe(true);
      expect(JSON.parse(lines[0]!.split("\t")[1]!)).toMatchObject({
        conversationId: "conv-123",
        transcriptPath: "C:\\path\\to\\transcript.jsonl",
        modelName: "Gemini 3.7 Flash",
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("streams reasoning traces from thinking steps and assistant text from final steps in transcript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-transcript-test-"));
    const transcriptDir = path.join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      "conv-test-1",
      ".system_generated",
      "logs",
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "item.started" ||
                event.type === "content.delta" ||
                event.type === "item.completed",
            ),
            Stream.take(8),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-transcript");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({
            threadId,
            input: "solve problem",
            attachments: [],
          });

          expect(eventFile).toBeTruthy();
          // 1. Hook fires with learned transcriptPath
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conv-test-1",
                transcriptPath: transcriptFile,
              })}\n`,
            ),
          );

          // 2. Transcript records a reasoning step (with tool_calls and thinking) + an assistant completion step
          yield* Effect.promise(() =>
            fs.appendFile(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 0,
                  type: "USER_INPUT",
                  content: "solve problem",
                }),
                JSON.stringify({
                  step_index: 1,
                  type: "PLANNER_RESPONSE",
                  thinking: "Analyzing problem requirements...",
                  tool_calls: [{ name: "run_command", args: { CommandLine: "echo test" } }],
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  content: "Here is the solution.",
                }),
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(events).toHaveLength(8);
          // Reasoning item: started -> delta -> completed
          expect(events[0]?.payload).toMatchObject({
            itemType: "reasoning",
            status: "inProgress",
            title: "Reasoning",
          });
          expect(events[1]?.payload).toMatchObject({
            streamKind: "reasoning_text",
            delta: "Analyzing problem requirements...",
          });
          expect(events[2]?.payload).toMatchObject({
            itemType: "reasoning",
            status: "completed",
            title: "Reasoning",
            detail: "Analyzing problem requirements...",
          });
          // Tool call from the transcript body surfaces as a tool lifecycle
          // item even though no pre/post-tool hook event fired: reasoning ->
          // run_command -> assistant. (#antigravity tool calls are displayed)
          expect(events[3]?.payload).toMatchObject({
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
            data: {
              toolName: "run_command",
              command: "echo test",
              arguments: { CommandLine: "echo test" },
            },
          });
          expect(events[4]?.payload).toMatchObject({
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
            data: {
              toolName: "run_command",
              command: "echo test",
              arguments: { CommandLine: "echo test" },
            },
          });
          // Assistant message: started -> delta -> completed
          expect(events[5]?.payload).toMatchObject({
            itemType: "assistant_message",
            status: "inProgress",
            title: "Assistant",
          });
          expect(events[6]?.payload).toMatchObject({
            streamKind: "assistant_text",
            delta: "Here is the solution.",
          });
          expect(events[7]?.payload).toMatchObject({
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant",
          });

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-transcript-test-" }),
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

describe("Antigravity background task helpers (#752)", () => {
  it("parses system message task ids and exit codes", () => {
    expect(parseAntigravitySystemMessage("plain assistant text")).toBeNull();
    expect(parseAntigravitySystemMessage(undefined)).toBeNull();

    const success = parseAntigravitySystemMessage(
      "<SYSTEM_MESSAGE> Task id 'task-abc123' exited with code 0",
    );
    expect(success).toMatchObject({
      isSystemMessage: true,
      taskId: "task-abc123",
      exitCode: 0,
      isFailure: false,
    });

    const failure = parseAntigravitySystemMessage(
      '<SYSTEM_MESSAGE> sender=task-9f2 Task id "task-9f2" exited with code 1',
    );
    expect(failure).toMatchObject({
      isSystemMessage: true,
      taskId: "task-9f2",
      sender: "task-9f2",
      exitCode: 1,
      isFailure: true,
    });

    const senderOnly = parseAntigravitySystemMessage("<SYSTEM_MESSAGE> sender=task-x77 done");
    expect(senderOnly).toMatchObject({ isSystemMessage: true, taskId: "task-x77" });

    expect(
      parseAntigravitySystemMessage(
        "<SYSTEM_MESSAGE> Task id 'task-clean' completed with 0 failed and no error",
      ),
    ).toMatchObject({ taskId: "task-clean", isFailure: false });
    expect(
      parseAntigravitySystemMessage(
        "<SYSTEM_MESSAGE> Task id 'task-tests' completed with 0 tests failed",
      ),
    ).toMatchObject({ taskId: "task-tests", isFailure: false });
  });

  it("detects background task starts from run_command tool output", () => {
    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev" },
        {
          toolOutput: "Task id 'task-42' is now running in the background",
        },
      ),
    ).toEqual({
      taskId: "task-42",
      description: "npm run dev",
      isBackground: true,
    });

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev" },
        {
          result: "sent to the background",
        },
      ),
    ).toEqual({ description: "npm run dev", isBackground: true });

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { command: "npm run dev", WaitMsBeforeAsync: 1000 },
        {},
      ),
    ).toEqual({ description: "npm run dev", isBackground: true });

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev", WaitMsBeforeAsync: 1000 },
        { toolOutput: "exited with code 0" },
      ),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "echo task-42" },
        { toolOutput: "foreground command printed task-42 and exited with code 0" },
      ),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev", WaitMsBeforeAsync: 1000 },
        { failed: true },
      ),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTaskStart("run_command", {
        CommandLine: "npm run dev",
        WaitMsBeforeAsync: 1000,
      }),
    ).toBeNull();
  });

  it("detects schedule timers and ignores unrelated tools", () => {
    expect(
      detectAntigravityBackgroundTaskStart(
        "schedule",
        { Prompt: "remind me later" },
        {
          toolOutput: "Scheduled timer-77 created",
        },
      ),
    ).toEqual({
      taskId: "timer-77",
      description: "remind me later",
      isBackground: true,
    });

    expect(detectAntigravityBackgroundTaskStart("schedule", {})).toEqual({
      description: "Scheduled timer",
      isBackground: true,
    });

    expect(
      detectAntigravityBackgroundTaskStart(
        "schedule",
        { Prompt: "remind me later" },
        {
          error: "scheduler unavailable",
        },
      ),
    ).toBeNull();

    expect(detectAntigravityBackgroundTaskStart("list_files")).toBeNull();
  });

  it("matches completion task ids against tracked tasks", () => {
    const tracked = ["task-1", "task-2"];

    expect(matchAntigravityTrackedTaskId("task-1", tracked)).toBe("task-1");
    expect(matchAntigravityTrackedTaskId("job/task-2", tracked)).toBe("task-2");
    expect(matchAntigravityTrackedTaskId("unknown-99", tracked)).toBeUndefined();
    expect(matchAntigravityTrackedTaskId(undefined, ["task-solo"])).toBe("task-solo");
    expect(matchAntigravityTrackedTaskId("another-task", ["task-solo"])).toBeUndefined();
    expect(matchAntigravityTrackedTaskId(undefined, tracked)).toBeUndefined();
    expect(matchAntigravityTrackedTaskId("task-1", [])).toBeUndefined();
  });

  it("settles a completed background task before handling the final stop hook", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-background-stop-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    let teardownCalls = 0;
    let resolveTeardown = (): void => undefined;
    const teardownObserved = new Promise<void>((resolve) => {
      resolveTeardown = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const toolsCompleted = yield* Deferred.make<void>();
          const followupObserved = yield* Deferred.make<void>();
          const runtimeTaskEvents: string[] = [];
          let completedTools = 0;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type.startsWith("task.")) runtimeTaskEvents.push(event.type);
                if (event.type === "item.completed" && ++completedTools === 2) {
                  yield* Deferred.succeed(toolsCompleted, undefined);
                }
                if (
                  event.type === "item.completed" &&
                  event.payload.itemType === "assistant_message"
                ) {
                  yield* Deferred.succeed(followupObserved, undefined);
                }
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-background-stop");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({ threadId, input: "run tests", attachments: [] });

          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                `pre-invocation\t${JSON.stringify({
                  conversationId: "conversation-background-stop",
                  transcriptPath: transcriptFile,
                })}`,
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"sent to the background"}',
                'pre-tool\t{"stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run dev","WaitMsBeforeAsync":1000}}}',
                'post-tool\t{"stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run dev","WaitMsBeforeAsync":1000}},"toolOutput":"sent to the background"}',
                'post-tool\t{"stepIdx":3,"toolCall":{"name":"manage_task","args":{"Action":"kill","TaskId":"task-real-a"}}}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(toolsCompleted).pipe(Effect.timeout("2 seconds"));
          expect(teardownCalls).toBe(0);

          yield* Effect.sync(() => {
            fsSync.appendFileSync(
              transcriptFile,
              [
                JSON.stringify({
                  type: "SYSTEM_MESSAGE",
                  content: "<SYSTEM_MESSAGE> Task id 'task-real-b' exited with code 0",
                }),
                JSON.stringify({
                  step_index: 6,
                  type: "PLANNER_RESPONSE",
                  content: "background work completed",
                }),
                "",
              ].join("\n"),
            );
            fsSync.appendFileSync(eventFile!, 'stop\t{"stepIdx":4}\n');
          });
          yield* Deferred.await(followupObserved).pipe(Effect.timeout("2 seconds"));
          expect(teardownCalls).toBe(0);
          yield* Effect.sync(() => fsSync.appendFileSync(eventFile!, "stop\t{}\n"));
          yield* Effect.promise(() => teardownObserved).pipe(Effect.timeout("2 seconds"));
          expect(teardownCalls).toBe(1);
          expect(runtimeTaskEvents).toEqual([]);
          yield* Fiber.interrupt(eventsFiber);

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: async () => {
                teardownCalls += 1;
                resolveTeardown();
              },
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-background-stop-" }),
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

  it("performs a fresh final hook drain when the process closes during a poll", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-final-drain-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    let blockNextTranscriptRead = false;
    let transcriptReadBlocked = false;
    let resolveTranscriptReadStarted = (): void => undefined;
    const transcriptReadStarted = new Promise<void>((resolve) => {
      resolveTranscriptReadStarted = resolve;
    });
    let releaseTranscriptRead = (): void => undefined;
    const transcriptReadRelease = new Promise<void>((resolve) => {
      releaseTranscriptRead = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const readCompleteLines: NonNullable<
      AntigravityAdapterDependencies["readCompleteLines"]
    > = async (filePath, offset) => {
      if (filePath === transcriptFile && blockNextTranscriptRead && !transcriptReadBlocked) {
        transcriptReadBlocked = true;
        resolveTranscriptReadStarted();
        await transcriptReadRelease;
      }
      return readCompleteAntigravityLines(filePath, offset);
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const turnCompleted = yield* Deferred.make<void>();
          const itemsObserved = yield* Deferred.make<void>();
          const itemEventTypes: string[] = [];
          const itemEventTitles: string[] = [];
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === "item.started" || event.type === "item.completed") {
                  itemEventTypes.push(event.type);
                  itemEventTitles.push(event.payload.title);
                  if (itemEventTypes.length === 2) {
                    yield* Deferred.succeed(itemsObserved, undefined);
                  }
                }
                if (event.type === "turn.completed") {
                  yield* Deferred.succeed(turnCompleted, undefined);
                }
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-final-drain");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({ threadId, input: "list files", attachments: [] });
          blockNextTranscriptRead = true;
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conversation-final-drain",
                transcriptPath: transcriptFile,
              })}\n`,
            ),
          );
          yield* Effect.promise(() => transcriptReadStarted).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"list_files","args":{"Path":"."}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"list_files","args":{"Path":"."}},"toolOutput":"ok"}',
                'stop\t{"stepIdx":2}',
                "",
              ].join("\n"),
            ),
          );
          child?.emit("close", 0, null);
          releaseTranscriptRead();

          yield* Deferred.await(itemsObserved).pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(turnCompleted).pipe(Effect.timeout("2 seconds"));
          expect(itemEventTypes).toEqual(["item.started", "item.completed"]);
          expect(itemEventTitles).toEqual(["list_files", "list_files"]);
          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              readCompleteLines,
              spawnProcess,
              teardownProcessTree: async () => undefined,
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "final-drain-" })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a hook poll that resumes after session replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stale-poll-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");

    let eventFile: string | undefined;
    let blockedEventFile: string | undefined;
    let replacementEventFile: string | undefined;
    let hookReadBlocked = false;
    let resolveHookReadStarted = (): void => undefined;
    const hookReadStarted = new Promise<void>((resolve) => {
      resolveHookReadStarted = resolve;
    });
    let releaseHookRead = (): void => undefined;
    const hookReadRelease = new Promise<void>((resolve) => {
      releaseHookRead = resolve;
    });
    let resolveReplacementPoll = (): void => undefined;
    const replacementPollObserved = new Promise<void>((resolve) => {
      resolveReplacementPoll = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const readCompleteLines: NonNullable<
      AntigravityAdapterDependencies["readCompleteLines"]
    > = async (filePath, offset) => {
      const batch = await readCompleteAntigravityLines(filePath, offset);
      if (filePath === blockedEventFile && !hookReadBlocked) {
        hookReadBlocked = true;
        resolveHookReadStarted();
        await hookReadRelease;
      }
      if (filePath === replacementEventFile) resolveReplacementPoll();
      return batch;
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const staleTaskIds: string[] = [];
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "task.started") staleTaskIds.push(event.payload.taskId);
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stale-poll");
          const sessionInput = {
            provider: "antigravity" as const,
            threadId,
            runtimeMode: "full-access" as const,
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          };
          yield* adapter.startSession(sessionInput);
          yield* adapter.sendTurn({ threadId, input: "start a task", attachments: [] });
          blockedEventFile = eventFile;
          yield* Effect.promise(() =>
            fs.appendFile(
              blockedEventFile!,
              [
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"Task id \'task-stale\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Effect.promise(() => hookReadStarted).pipe(Effect.timeout("2 seconds"));

          yield* adapter.startSession(sessionInput);
          releaseHookRead();
          yield* adapter.sendTurn({ threadId, input: "replacement turn", attachments: [] });
          replacementEventFile = eventFile;
          yield* Effect.promise(() => replacementPollObserved).pipe(Effect.timeout("2 seconds"));

          expect(staleTaskIds).toEqual([]);
          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              readCompleteLines,
              spawnProcess,
              teardownProcessTree: async () => undefined,
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "stale-poll-" })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("settles pending background tasks on session replacement and process exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-background-restart-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const firstTaskStarted = yield* Deferred.make<void>();
          const conversationReady = yield* Deferred.make<void>();
          const completionBuffered = yield* Deferred.make<void>();
          const bufferedTaskCompleted = yield* Deferred.make<void>();
          const secondTurnCompleted = yield* Deferred.make<void>();
          const exitTaskStarted = yield* Deferred.make<void>();
          const taskEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              Effect.all(
                [
                  event.type === "task.started" && event.payload.taskId === "task-restart"
                    ? Deferred.succeed(firstTaskStarted, undefined)
                    : Effect.void,
                  event.type === "thread.started" &&
                  event.payload.providerThreadId === "conversation-background-restart"
                    ? Deferred.succeed(conversationReady, undefined)
                    : Effect.void,
                  event.type === "item.completed" && event.payload.itemType === "assistant_message"
                    ? Deferred.succeed(completionBuffered, undefined)
                    : Effect.void,
                  event.type === "task.completed" && event.payload.taskId === "task-buffered"
                    ? Deferred.succeed(bufferedTaskCompleted, undefined)
                    : Effect.void,
                  event.type === "turn.completed"
                    ? Deferred.succeed(secondTurnCompleted, undefined)
                    : Effect.void,
                  event.type === "task.started" && event.payload.taskId === "task-exit"
                    ? Deferred.succeed(exitTaskStarted, undefined)
                    : Effect.void,
                ],
                { discard: true },
              ),
            ),
            Stream.filter(
              (event) =>
                event.type === "task.started" ||
                event.type === "task.updated" ||
                event.type === "task.completed",
            ),
            Stream.take(6),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-background-restart");
          const sessionInput = {
            provider: "antigravity" as const,
            threadId,
            runtimeMode: "full-access" as const,
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          };
          yield* adapter.startSession(sessionInput);
          yield* adapter.sendTurn({ threadId, input: "run tests", attachments: [] });

          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command"},"toolOutput":"Task id \'task-restart\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(firstTaskStarted).pipe(Effect.timeout("2 seconds"));
          yield* adapter.startSession(sessionInput);

          yield* adapter.sendTurn({ threadId, input: "run more tests", attachments: [] });
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conversation-background-restart",
                transcriptPath: transcriptFile,
              })}\n`,
            ),
          );
          yield* Deferred.await(conversationReady).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            fs.appendFile(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 2,
                  type: "SYSTEM_MESSAGE",
                  content: "<SYSTEM_MESSAGE> Task id 'task-buffered' exited with code 0",
                }),
                JSON.stringify({
                  step_index: 3,
                  type: "PLANNER_RESPONSE",
                  content: "buffer-ready",
                }),
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(completionBuffered).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'post-tool\t{"stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run dev","WaitMsBeforeAsync":1000}},"toolOutput":"sent to the background"}',
                'post-tool\t{"stepIdx":3,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"Task id \'task-buffered\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(bufferedTaskCompleted).pipe(Effect.timeout("2 seconds"));
          child?.emit("close", 0, null);
          yield* Deferred.await(secondTurnCompleted).pipe(Effect.timeout("2 seconds"));

          yield* adapter.sendTurn({ threadId, input: "run final tests", attachments: [] });
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'post-tool\t{"stepIdx":3,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"Task id \'task-exit\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(exitTaskStarted).pipe(Effect.timeout("2 seconds"));
          child?.emit("close", 1, null);

          const taskEvents = Array.from(
            yield* Fiber.join(taskEventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(taskEvents.map((event) => event.type)).toEqual([
            "task.started",
            "task.updated",
            "task.started",
            "task.completed",
            "task.started",
            "task.completed",
          ]);
          expect(taskEvents[1]?.payload).toMatchObject({
            taskId: "task-restart",
            status: "killed",
          });
          expect(taskEvents[3]?.payload).toMatchObject({
            taskId: "task-buffered",
            status: "completed",
          });
          expect(taskEvents[5]?.payload).toMatchObject({
            taskId: "task-exit",
            status: "failed",
          });
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: async () => undefined,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-background-restart-" }),
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

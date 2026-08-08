import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
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
        'pre-tool\t{"conversationId":"conversation-1","transcriptPath":"/tmp/transcript.jsonl","stepIdx":12,"toolCall":{"name":"run_command"}}\n',
      );
      expect(captured).not.toContain("super-secret-token");
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

  it("streams hook tool names and terminal states without arguments", async () => {
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
              },
            },
            {
              itemType: "command_execution",
              status: "failed",
              title: "run_command",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-0`,
                toolName: "run_command",
              },
            },
            {
              itemType: "file_change",
              status: "inProgress",
              title: "write_to_file",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-1`,
                toolName: "write_to_file",
              },
            },
            {
              itemType: "file_change",
              status: "completed",
              title: "write_to_file",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-1`,
                toolName: "write_to_file",
              },
            },
          ]);
          expect(JSON.stringify(events)).not.toContain("super-secret");

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
});

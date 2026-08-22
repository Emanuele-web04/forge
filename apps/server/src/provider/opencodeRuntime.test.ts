// FILE: opencodeRuntime.test.ts
// Purpose: Covers OpenCode runtime parsing and local server startup diagnostics.
// Layer: Provider runtime tests
// Exports: Vitest suites for opencodeRuntime.ts

import os from "node:os";
import { pathToFileURL } from "node:url";

import { Duration, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import type { ChatAttachment } from "@synara/contracts";
import { resolveWindowsComSpec } from "@synara/shared/windowsProcess";
import { describe, expect, it, vi } from "vitest";

import {
  buildOpenCodePermissionRules,
  buildOpenCodeServerProcessEnv,
  KILO_CLI_SPEC,
  KILO_CREDENTIAL_STARTUP_RETRY_DELAYS_MS,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  makeOpenCodeRuntimeLive,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  parseOpenCodeCliModelsOutput,
  parseOpenCodeCredentialProviderIDs,
  resolveOpenCodeAuthFilePath,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";
import { resolveOpenCodeCompatibleAuthPaths } from "./openCodeAuthPaths.ts";

const encoder = new TextEncoder();

describe("OpenCode permission policy", () => {
  it("keeps full access non-interactive while enforcing read-only Plan turns", () => {
    expect(buildOpenCodePermissionRules("full-access")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    expect(buildOpenCodePermissionRules("full-access", "plan")).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "allow" },
      { permission: "websearch", pattern: "*", action: "allow" },
      { permission: "codesearch", pattern: "*", action: "allow" },
      { permission: "todoread", pattern: "*", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
    ]);
  });
});

function mockOpenCodeServerHandle(input: {
  stdout: string;
  stderr: string;
  pid?: number;
  exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, never>;
  kill?: () => Effect.Effect<void, never>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid ?? 1),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill: input.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout)),
    stderr: Stream.make(encoder.encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockOpenCodeServerSpawnerLayer(input: {
  stdout: string;
  stderr: string;
  spawnedCommands?: Array<ChildProcess.StandardCommand>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") input.spawnedCommands?.push(command);
      return Effect.succeed(mockOpenCodeServerHandle(input));
    }),
  );
}

function mockPooledOpenCodeServerSpawnerLayer(state: {
  spawnUrls: Array<string>;
  spawnCwds?: Array<string | undefined>;
  killUrls: Array<string>;
  processUrls?: Map<number, string>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        options?: { cwd?: string };
      };
      const url = `http://127.0.0.1:${59000 + state.spawnUrls.length}`;
      const pid = 59_000 + state.spawnUrls.length;
      state.spawnUrls.push(url);
      state.spawnCwds?.push(cmd.options?.cwd);
      state.processUrls?.set(pid, url);
      return Effect.succeed(
        mockOpenCodeServerHandle({
          stdout: `opencode server listening on ${url}\n`,
          stderr: "",
          pid,
          kill: () =>
            Effect.sync(() => {
              state.killUrls.push(url);
            }),
        }),
      );
    }),
  );
}

const advanceOpenCodePoolIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

const advanceOpenCodePoolAlmostToIdle = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS - 1));
  yield* Effect.yieldNow;
});

function openCodeRuntimePoolTestLayer(state: {
  spawnUrls: Array<string>;
  killUrls: Array<string>;
}) {
  const processUrls = new Map<number, string>();
  return Layer.merge(
    makeOpenCodeRuntimeLive({
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      teardownProcessTree: async ({ rootPid }) => {
        const url = processUrls.get(rootPid);
        if (url) state.killUrls.push(url);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls }))),
    TestClock.layer(),
  );
}

describe("toOpenCodeFileParts", () => {
  it("materializes image attachments as SDK file parts", () => {
    const attachment = {
      type: "image",
      id: "thread-attachment-image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/synara-attachments/screenshot.png",
      }),
    ).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: pathToFileURL("/tmp/synara-attachments/screenshot.png").href,
      },
    ]);
  });

  it("leaves generic files for prompt-path projection", () => {
    const attachment = {
      type: "file",
      id: "thread-attachment-file",
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/synara-attachments/notes.docx",
      }),
    ).toEqual([]);
  });
});

describe("buildOpenCodeServerProcessEnv", () => {
  it("does not override file-based config with synthetic empty config content", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        PATH: "/usr/bin",
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves an explicitly configured config-content environment value", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"provider":{"openai":{}}}');
  });

  it("strips inherited Synara authority from managed server processes", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENAI_API_KEY: "provider-key",
        SYNARA_AUTH_TOKEN: "server-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
      },
    });

    expect(env.OPENAI_API_KEY).toBe("provider-key");
    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.SYNARA_BROWSER_USE_PIPE_PATH).toBeUndefined();
  });
});

describe("OpenCodeRuntime startup diagnostics", () => {
  it("wraps Windows .cmd server shims before spawning", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const spawnedCommands: Array<ChildProcess.StandardCommand> = [];

    try {
      const server = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            return yield* runtime.startOpenCodeServerProcess({
              binaryPath: "C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd",
              hostname: "127.0.0.1",
              port: 58_123,
            });
          }),
        ).pipe(
          Effect.provide(
            makeOpenCodeRuntimeLive({
              teardownProcessTree: async () => ({
                escalated: false,
                signalErrors: [],
              }),
            }).pipe(
              Layer.provide(
                mockOpenCodeServerSpawnerLayer({
                  stdout: "opencode server listening on http://127.0.0.1:58123\n",
                  stderr: "",
                  spawnedCommands,
                }),
              ),
            ),
          ),
        ),
      );

      expect(server.url).toBe("http://127.0.0.1:58123");
      expect(spawnedCommands).toHaveLength(1);
      expect(spawnedCommands[0]).toMatchObject({
        command: resolveWindowsComSpec(),
        args: [
          "/d",
          "/s",
          "/v:off",
          "/c",
          'call "C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd" "serve" "--hostname" "127.0.0.1" "--port" "58123"',
        ],
        options: {
          shell: false,
          windowsVerbatimArguments: true,
        },
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("includes command and partial process output when server startup times out", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "booting custom OpenCode wrapper\n",
                stderr: "loading provider credentials\n",
              }),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("Timed out waiting for OpenCode server start after 5ms.");
    expect(error.detail).toContain(
      "command: /custom/bin/opencode serve --hostname 127.0.0.1 --port 58123",
    );
    expect(error.detail).toContain('OpenCode ready prefix: "opencode server listening"');
    expect(error.detail).toContain("stdout:\nbooting custom OpenCode wrapper");
    expect(error.detail).toContain("stderr:\nloading provider credentials");
  });

  it("redacts likely secrets from startup timeout diagnostics and causes", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "OPENAI_API_KEY=sk-live-123\nauth_token: token-abc\nsafe line\n",
                stderr: 'Authorization: Bearer auth-secret\nserverPassword="pw-secret"\n',
              }),
            ),
          ),
        ),
      ),
    );
    const causeJson = JSON.stringify(error.cause);

    expect(error.detail).toContain("OPENAI_API_KEY=[redacted]");
    expect(error.detail).toContain("auth_token: [redacted]");
    expect(error.detail).toContain("Authorization: Bearer [redacted]");
    expect(error.detail).toContain('serverPassword="[redacted]"');
    expect(error.detail).toContain("safe line");
    for (const secret of ["sk-live-123", "token-abc", "auth-secret", "pw-secret"]) {
      expect(error.detail).not.toContain(secret);
      expect(causeJson).not.toContain(secret);
    }
  });
});

describe("OpenCodeRuntime local server pool", () => {
  it("retries transient Kilo credential-store startup failures", async () => {
    let spawnCount = 0;
    let teardownCount = 0;
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        spawnCount += 1;
        if (spawnCount < 3) {
          return Effect.succeed(
            mockOpenCodeServerHandle({
              stdout: "",
              stderr:
                '\u001b[91mError: Unexpected error Failed query: update "credential" set "value" = ?\n',
              pid: spawnCount,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            }),
          );
        }
        return Effect.succeed(
          mockOpenCodeServerHandle({
            stdout: "kilo server listening on http://127.0.0.1:59002\n",
            stderr: "",
            pid: spawnCount,
          }),
        );
      }),
    );
    const layer = Layer.merge(
      makeOpenCodeRuntimeLive({
        netService: {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(59_000),
          findAvailablePort: () => Effect.succeed(59_000),
        },
        teardownProcessTree: async () => {
          teardownCount += 1;
          return { escalated: false, signalErrors: [] };
        },
      }).pipe(Layer.provide(spawnerLayer)),
      TestClock.layer(),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const serverScope = yield* Scope.make();
          const connectionFiber = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "kilo",
              cliSpec: KILO_CLI_SPEC,
              poolIsolationKey: "synara-kilo-thread",
            })
            .pipe(Effect.provideService(Scope.Scope, serverScope), Effect.forkChild);

          for (const delayMs of KILO_CREDENTIAL_STARTUP_RETRY_DELAYS_MS) {
            yield* Effect.yieldNow;
            yield* TestClock.adjust(Duration.millis(delayMs));
          }

          const connection = yield* Fiber.join(connectionFiber);
          expect(connection.url).toBe("http://127.0.0.1:59002");
          expect(spawnCount).toBe(3);
          expect(teardownCount).toBe(2);

          yield* Scope.close(serverScope, Exit.void);
          expect(teardownCount).toBe(3);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("does not retry unrelated Kilo startup failures", async () => {
    let spawnCount = 0;
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        spawnCount += 1;
        return Effect.succeed(
          mockOpenCodeServerHandle({
            stdout: "",
            stderr: "Error: invalid Kilo configuration\n",
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          }),
        );
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
    }).pipe(Layer.provide(spawnerLayer));

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .connectToOpenCodeServer({ binaryPath: "kilo", cliSpec: KILO_CLI_SPEC })
            .pipe(Effect.flip);
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(spawnCount).toBe(1);
    expect(error.detail).toContain("invalid Kilo configuration");
  });

  it("keeps server scope closure pending until process-tree exit is proven", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let teardownCalls = 0;
    const layer = makeOpenCodeRuntimeLive({
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
        expect(rootPid).toBe(1);
        await exitProof;
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        mockOpenCodeServerSpawnerLayer({
          stdout: "opencode server listening on http://127.0.0.1:59000\n",
          stderr: "",
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const serverScope = yield* Scope.make("sequential");
          yield* runtime
            .startOpenCodeServerProcess({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, serverScope));

          const closing = yield* Scope.close(serverScope, Exit.void).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(1);
          expect(closing.pollUnsafe()).toBeUndefined();

          proveExit?.();
          yield* Fiber.join(closing);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("reuses a local server while scoped sessions are active and closes it after idling", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.external).toBe(false);
          expect(first.url).toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

          const thirdScope = yield* Scope.make();
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));
          expect(third.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("isolates same-cwd owners and closes private servers immediately on release", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "synara-thread-a",
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "synara-thread-b",
            })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.url).not.toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
          yield* Scope.close(secondScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("does not spawn or pool when an external OpenCode server URL is configured", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const connection = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            serverUrl: " http://127.0.0.1:9999 ",
          });

          expect(connection).toMatchObject({
            url: "http://127.0.0.1:9999",
            exitCode: null,
            external: true,
          });
          expect(state.spawnUrls).toEqual([]);
          expect(state.killUrls).toEqual([]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps the warm server alive when a new session starts before idle expiry", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));

          yield* Scope.close(firstScope, Exit.void);
          yield* advanceOpenCodePoolAlmostToIdle;

          const secondScope = yield* Scope.make();
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(second.url).toBe(first.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps incompatible local server keys separate", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const defaultServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const customServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "/custom/bin/opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(defaultServer.url).toBe("http://127.0.0.1:59000");
          expect(customServer.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("starts local servers in the requested cwd and separates cwd-specific pools", async () => {
    const state = {
      spawnUrls: [] as Array<string>,
      spawnCwds: [] as Array<string | undefined>,
      killUrls: [] as Array<string>,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const thirdScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/beta" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));

          expect(first.url).toBe("http://127.0.0.1:59000");
          expect(second.url).toBe("http://127.0.0.1:59001");
          expect(third.url).toBe(first.url);
          expect(state.spawnCwds).toEqual(["/repo/alpha", "/repo/beta"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });
});

describe("parseOpenCodeCliModelsOutput", () => {
  it("parses verbose OpenCode model output with metadata blocks", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
opencode/gpt-5-nano
{
  "id": "gpt-5-nano",
  "providerID": "opencode",
  "name": "GPT-5 Nano",
  "variants": {}
}
`);

    expect(models).toEqual([
      {
        slug: "opencode/gpt-5-nano",
        providerID: "opencode",
        modelID: "gpt-5-nano",
        name: "GPT-5 Nano",
        variants: [],
        supportedReasoningEfforts: [],
      },
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4",
        variants: ["high", "low"],
        supportedReasoningEfforts: [
          {
            value: "low",
          },
          {
            value: "high",
          },
        ],
      },
    ]);
  });

  it("falls back to slug-derived metadata when only plain model lines are present", () => {
    const models = parseOpenCodeCliModelsOutput(`
warning: cached model metadata is unavailable
openai/gpt-5.4
opencode/minimax-m2.5-free
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "gpt-5.4",
        variants: [],
        supportedReasoningEfforts: [],
      },
      {
        slug: "opencode/minimax-m2.5-free",
        providerID: "opencode",
        modelID: "minimax-m2.5-free",
        name: "minimax-m2.5-free",
        variants: [],
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it("deduplicates repeated slug entries by keeping the latest descriptor", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4"
}
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4 Latest"
}
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4 Latest",
        variants: [],
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it("keeps verbose reasoning metadata from CLI output", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4",
  "options": {
    "reasoningEffort": "medium"
  },
  "variants": {
    "none": {
      "reasoningEffort": "none"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4",
        variants: ["high", "low", "medium", "none"],
        supportedReasoningEfforts: [
          { value: "none" },
          { value: "low" },
          { value: "medium" },
          { value: "high" },
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("reads current OpenCode variant effort shapes from verbose CLI output", () => {
    const models = parseOpenCodeCliModelsOutput(`
opencode/claude-opus-4-7
{
  "id": "claude-opus-4-7",
  "providerID": "opencode",
  "name": "Claude Opus 4.7",
  "options": {
    "effort": "high"
  },
  "variants": {
    "low": {
      "thinking": {
        "type": "adaptive"
      }
    },
    "medium": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "medium"
    },
    "high": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "high"
    },
    "xhigh": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "xhigh"
    },
    "max": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "max"
    }
  }
}
opencode/gemini-3-flash
{
  "id": "gemini-3-flash",
  "providerID": "opencode",
  "name": "Gemini 3 Flash",
  "variants": {
    "minimal": {
      "thinkingConfig": {
        "thinkingLevel": "minimal"
      }
    },
    "high": {
      "thinkingConfig": {
        "thinkingLevel": "high"
      }
    }
  }
}
openrouter/grok-3-mini
{
  "id": "grok-3-mini",
  "providerID": "openrouter",
  "name": "Grok 3 Mini",
  "variants": {
    "low": {
      "reasoning": {
        "effort": "low"
      }
    },
    "high": {
      "reasoning": {
        "effort": "high"
      }
    }
  }
}
amazon-bedrock/nova-reel
{
  "id": "nova-reel",
  "providerID": "amazon-bedrock",
  "name": "Nova Reel",
  "variants": {
    "medium": {
      "reasoningConfig": {
        "maxReasoningEffort": "medium"
      }
    }
  }
}
`);

    expect(models).toEqual([
      {
        slug: "opencode/claude-opus-4-7",
        providerID: "opencode",
        modelID: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        variants: ["high", "low", "max", "medium", "xhigh"],
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
        ],
        defaultReasoningEffort: "high",
      },
      {
        slug: "opencode/gemini-3-flash",
        providerID: "opencode",
        modelID: "gemini-3-flash",
        name: "Gemini 3 Flash",
        variants: ["high", "minimal"],
        supportedReasoningEfforts: [{ value: "minimal" }, { value: "high" }],
      },
      {
        slug: "openrouter/grok-3-mini",
        providerID: "openrouter",
        modelID: "grok-3-mini",
        name: "Grok 3 Mini",
        variants: ["high", "low"],
        supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
      },
      {
        slug: "amazon-bedrock/nova-reel",
        providerID: "amazon-bedrock",
        modelID: "nova-reel",
        name: "Nova Reel",
        variants: ["medium"],
        supportedReasoningEfforts: [{ value: "medium" }],
      },
    ]);
  });
});

describe("parseOpenCodeCredentialProviderIDs", () => {
  it("returns top-level provider ids from the OpenCode credential store", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "openai": {
    "type": "oauth"
  },
  "opencode": {
    "type": "api"
  }
}`);

    expect(providerIDs).toEqual(["openai", "opencode"]);
  });

  it("ignores non-object entries and empty keys", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "": {
    "type": "oauth"
  },
  "openai": {
    "type": "oauth"
  },
  "broken": "nope"
}`);

    expect(providerIDs).toEqual(["openai"]);
  });
});

describe("resolveOpenCodeAuthFilePath", () => {
  it("uses the shared OpenCode-compatible candidate list for the current process", () => {
    const home = os.homedir();
    expect(resolveOpenCodeAuthFilePath({ home })).toBe(
      resolveOpenCodeCompatibleAuthPaths({
        homeDir: home,
        env: process.env,
        platform: process.platform,
        dataDirectoryName: "opencode",
      })[0],
    );
  });
});

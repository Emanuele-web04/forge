import { describe, expect, it } from "vitest";

import { Deferred, Effect, Exit, Scope } from "effect";
import type * as Acp from "@agentclientprotocol/sdk";

import {
  assistantItemId,
  awaitAcpChildExit,
  decodeSetSessionConfigOptionResponse,
  makeAcpIncomingFrameGuard,
  runAcpFreshSessionSetup,
  sessionConfigOptionsFromSetup,
  teardownAcpChildProcess,
} from "./AcpSessionRuntime.ts";
import * as AcpErrors from "./AcpErrors.ts";

describe("makeAcpIncomingFrameGuard", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("enforces the frame budget across split chunks and resets it at newline boundaries", () => {
    const guard = makeAcpIncomingFrameGuard(5);

    expect(guard(encode("123"))).toBeUndefined();
    expect(guard(encode("45\n12345\n"))).toBeUndefined();
    expect(guard(encode("1\n"))).toBeUndefined();
  });

  it("rejects an oversized unterminated frame", () => {
    const guard = makeAcpIncomingFrameGuard(5);

    expect(guard(encode("123"))).toBeUndefined();
    const error = guard(encode("456"));
    expect(error?._tag).toBe("AcpTransportError");
    expect(error?.detail).toContain("5-byte limit");
  });
});

describe("teardownAcpChildProcess", () => {
  it("keeps ACP scope closure pending until the owned root exit settles", async () => {
    const processExited = Deferred.makeUnsafe<number>();
    const exitCode = Deferred.await(processExited);
    let observeTeardown!: (input: {
      readonly rootPid: number;
      readonly rootExited: Promise<unknown>;
    }) => void;
    const teardownStarted = new Promise<{
      readonly rootPid: number;
      readonly rootExited: Promise<unknown>;
    }>((resolve) => {
      observeTeardown = resolve;
    });
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(
      Effect.addFinalizer(() =>
        teardownAcpChildProcess({ pid: 4_242, exitCode }, async (input) => {
          observeTeardown(input);
          await input.rootExited;
          return { escalated: false, signalErrors: [] };
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    let scopeClosed = false;
    const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      scopeClosed = true;
    });
    const teardown = await teardownStarted;
    expect(teardown.rootPid).toBe(4_242);
    await Promise.resolve();
    expect(scopeClosed).toBe(false);

    Deferred.doneUnsafe(processExited, Effect.succeed(0));
    await closing;
    expect(scopeClosed).toBe(true);
  });
});

describe("awaitAcpChildExit", () => {
  it("completes for both successful and failed child exit signals", async () => {
    const successfulExit = Deferred.makeUnsafe<number>();
    const failedExit = Deferred.makeUnsafe<number, Error>();
    let successfulCompleted = false;
    let failedCompleted = false;

    const successfulWait = Effect.runPromise(
      awaitAcpChildExit({ pid: 1, exitCode: Deferred.await(successfulExit) }),
    ).then(() => {
      successfulCompleted = true;
    });
    const failedWait = Effect.runPromise(
      awaitAcpChildExit({ pid: 2, exitCode: Deferred.await(failedExit) }),
    ).then(() => {
      failedCompleted = true;
    });

    await Promise.resolve();
    expect(successfulCompleted).toBe(false);
    expect(failedCompleted).toBe(false);

    Deferred.doneUnsafe(successfulExit, Effect.succeed(0));
    Deferred.doneUnsafe(failedExit, Effect.fail(new Error("child exit signal failed")));
    await Promise.all([successfulWait, failedWait]);

    expect(successfulCompleted).toBe(true);
    expect(failedCompleted).toBe(true);
  });
});

describe("runAcpFreshSessionSetup", () => {
  it("retries one matching fresh-session failure and then succeeds", async () => {
    const retryable = new AcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Path not found.",
      data: { code: "FS_NOT_FOUND" },
    });
    let attempts = 0;
    const setup = Effect.suspend(() => {
      attempts += 1;
      return attempts === 1 ? Effect.fail(retryable) : Effect.succeed("session-ready");
    });

    await expect(
      Effect.runPromise(
        runAcpFreshSessionSetup(setup, {
          shouldRetry: (error) => error === retryable,
        }),
      ),
    ).resolves.toBe("session-ready");
    expect(attempts).toBe(2);
  });

  it("does not retry a non-matching failure", async () => {
    const terminal = new AcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Permission denied.",
      data: { code: "FS_PERMISSION_DENIED" },
    });
    let attempts = 0;
    const setup = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(terminal);
    });

    await expect(
      Effect.runPromise(
        runAcpFreshSessionSetup(setup, {
          shouldRetry: () => false,
        }),
      ),
    ).rejects.toThrow("Permission denied.");
    expect(attempts).toBe(1);
  });
});

describe("assistantItemId", () => {
  // Format contract only — distinct runtimeInstanceId wiring is covered by
  // AcpJsonRpcConnection.test.ts ("assigns distinct fallback assistant item ids...").
  it("produces distinct ids across runtime instances with the same session id and segment index", () => {
    const sessionId = "session-1";
    const a = assistantItemId(sessionId, "aaaa1111", 0);
    const b = assistantItemId(sessionId, "bbbb2222", 0);
    expect(a).not.toBe(b);
    expect(a).toBe("assistant:session-1:aaaa1111:segment:0");
    expect(b).toBe("assistant:session-1:bbbb2222:segment:0");
  });
});

describe("decodeSetSessionConfigOptionResponse", () => {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<Acp.SessionConfigOption>;

  it("uses the matching config update for an empty response", () => {
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse({}, Effect.succeed(configOptions)),
    );
    expect(decoded).toEqual({ configOptions });
  });

  it("strictly decodes a non-empty response without awaiting an update", () => {
    let awaitedUpdate = false;
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse(
        { configOptions },
        Effect.sync(() => {
          awaitedUpdate = true;
          return [];
        }),
      ),
    );
    expect(decoded).toEqual({ configOptions });
    expect(awaitedUpdate).toBe(false);
  });

  it("rejects an invalid non-empty response", async () => {
    const error = await Effect.runPromise(
      decodeSetSessionConfigOptionResponse(
        { unexpected: true },
        Effect.succeed(configOptions),
      ).pipe(Effect.flip),
    );
    expect(error._tag).toBe("AcpTransportError");
    if (error._tag === "AcpTransportError") {
      expect(error.detail).toContain("invalid session/set_config_option response");
    }
  });
});

describe("sessionConfigOptionsFromSetup", () => {
  const replayedConfigOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<Acp.SessionConfigOption>;

  it("preserves config retained from replay when setup omits configOptions", () => {
    expect(sessionConfigOptionsFromSetup({}, replayedConfigOptions)).toBe(replayedConfigOptions);
  });

  it("uses an explicit setup inventory instead of replayed config", () => {
    expect(sessionConfigOptionsFromSetup({ configOptions: [] }, replayedConfigOptions)).toEqual([]);
  });
});

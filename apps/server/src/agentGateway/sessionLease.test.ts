import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  acquireAgentGatewaySessionLease,
  AGENT_GATEWAY_NO_CAPABILITIES,
  cancelAgentGatewayTurn,
  releaseAgentGatewaySessionLeaseOnInterrupt,
  startAgentGatewaySessionLeaseExitWatcher,
  withAgentGatewayTurnCancellation,
} from "./sessionLease.ts";

describe("AgentGatewaySessionLease", () => {
  it("cancels one exact turn while the provider session lease is live", async () => {
    const cancelSessionTurnRequests = vi.fn(() => Promise.resolve());
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        cancelSessionTurnRequests,
        revokeSessionToken: vi.fn(),
      },
      ThreadId.makeUnsafe("thread-1"),
      "codex",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    await lease?.cancelTurn("turn-exact");
    expect(cancelSessionTurnRequests).toHaveBeenCalledOnce();
    expect(cancelSessionTurnRequests).toHaveBeenCalledWith("gateway-token", "turn-exact");

    lease?.release();
    await lease?.cancelTurn("turn-too-late");
    expect(cancelSessionTurnRequests).toHaveBeenCalledOnce();
  });

  it("retires terminal write authority without revoking the runtime until release", async () => {
    const retireSessionTurn = vi.fn(() => Promise.resolve());
    const revokeSessionToken = vi.fn();
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        retireSessionTurn,
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "codex",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    await lease?.retireTurn("turn-a");
    expect(retireSessionTurn).toHaveBeenCalledWith("gateway-token", "turn-a");
    expect(revokeSessionToken).not.toHaveBeenCalled();

    lease?.release();
    await lease?.retireTurn("turn-too-late");
    expect(retireSessionTurn).toHaveBeenCalledOnce();
    expect(revokeSessionToken).toHaveBeenCalledWith("gateway-token");
  });

  it("starts provider and gateway interruption concurrently and waits for the gateway barrier", async () => {
    let releaseGateway!: () => void;
    const gatewayBarrier = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const providerStarted = vi.fn();
    const gatewayStarted = vi.fn();
    const lease = {
      connection: {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: "gateway-token",
      },
      cancelTurn: vi.fn((turnId: string) => {
        gatewayStarted(turnId);
        return gatewayBarrier;
      }),
      retireTurn: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    };

    let settled = false;
    const interruption = Effect.runPromise(
      withAgentGatewayTurnCancellation(
        lease,
        "turn-exact",
        Effect.sync(() => providerStarted()),
      ),
    ).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(providerStarted).toHaveBeenCalledOnce();
      expect(gatewayStarted).toHaveBeenCalledWith("turn-exact");
    });
    expect(settled).toBe(false);

    releaseGateway();
    await interruption;
    expect(settled).toBe(true);
  });

  it("tombstones the turn and revokes its bearer before the provider interrupt starts", async () => {
    let released = false;
    const cancellationObservedReleasedState: boolean[] = [];
    const lease = {
      connection: {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: "gateway-token",
      },
      cancelTurn: vi.fn(() => {
        cancellationObservedReleasedState.push(released);
        return Promise.resolve();
      }),
      retireTurn: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => {
        released = true;
      }),
    };

    await Effect.runPromise(
      withAgentGatewayTurnCancellation(
        lease,
        "turn-exact",
        Effect.sync(() => expect(released).toBe(true)),
      ),
    );

    expect(cancellationObservedReleasedState).toEqual([false]);
    expect(released).toBe(true);
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("revokes the session before stopping a background child without a parent turn id", async () => {
    let released = false;
    const providerInterrupted = vi.fn();
    const lease = {
      connection: {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: "gateway-token",
      },
      cancelTurn: vi.fn(() => Promise.resolve()),
      retireTurn: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => {
        released = true;
      }),
    };

    await Effect.runPromise(
      withAgentGatewayTurnCancellation(
        lease,
        undefined,
        Effect.sync(() => {
          expect(released).toBe(true);
          providerInterrupted();
        }),
      ),
    );

    expect(lease.cancelTurn).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(providerInterrupted).toHaveBeenCalledOnce();
  });

  it("still interrupts the provider but fails closed when bearer revocation fails", async () => {
    const providerInterrupted = vi.fn();
    const lease = {
      connection: {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: "gateway-token",
      },
      cancelTurn: vi.fn(() => Promise.resolve()),
      retireTurn: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => {
        throw new Error("credential revocation failed");
      }),
    };

    await expect(
      Effect.runPromise(
        withAgentGatewayTurnCancellation(
          lease,
          "turn-exact",
          Effect.sync(() => providerInterrupted()),
        ),
      ),
    ).rejects.toThrow("credential revocation failed");
    expect(providerInterrupted).toHaveBeenCalledOnce();
  });

  it("preserves a provider interruption failure after the gateway barrier settles", async () => {
    let releaseGateway!: () => void;
    const gatewayBarrier = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const lease = {
      connection: {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: "gateway-token",
      },
      cancelTurn: vi.fn(() => gatewayBarrier),
      retireTurn: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    };

    let settled = false;
    const interruption = Effect.runPromise(
      withAgentGatewayTurnCancellation(
        lease,
        "turn-exact",
        Effect.fail(new Error("provider stop failed")),
      ),
    ).catch((error: unknown) => {
      settled = true;
      throw error;
    });

    await vi.waitFor(() => expect(lease.cancelTurn).toHaveBeenCalledWith("turn-exact"));
    expect(settled).toBe(false);
    releaseGateway();
    await expect(interruption).rejects.toThrow("provider stop failed");
  });

  it("does nothing when no exact turn is available", async () => {
    const lease = {
      connection: {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: "gateway-token",
      },
      cancelTurn: vi.fn(() => Promise.resolve()),
      retireTurn: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    };

    await Effect.runPromise(cancelAgentGatewayTurn(lease, undefined));
    expect(lease.cancelTurn).not.toHaveBeenCalled();
  });

  it("acquires one scoped connection and revokes it at most once", () => {
    const connectionForThread = vi.fn(() => ({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: "gateway-token",
    }));
    const revokeSessionToken = vi.fn();
    const issueStdioBootstrapToken = vi.fn(() => "one-shot-bootstrap");

    const lease = acquireAgentGatewaySessionLease(
      { connectionForThread, issueStdioBootstrapToken, revokeSessionToken },
      ThreadId.makeUnsafe("thread-1"),
      "cursor",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    expect(lease?.connection).toEqual({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: "gateway-token",
    });
    expect(connectionForThread).toHaveBeenCalledOnce();
    expect(connectionForThread).toHaveBeenCalledWith("thread-1", "cursor");
    expect(lease?.issueStdioBootstrapToken?.()).toBe("one-shot-bootstrap");
    expect(issueStdioBootstrapToken).toHaveBeenCalledWith("gateway-token");

    lease?.release();
    lease?.release();

    expect(lease?.issueStdioBootstrapToken?.()).toBeNull();

    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(revokeSessionToken).toHaveBeenCalledWith("gateway-token");
  });

  it("keeps replacement runtimes on independent leases", () => {
    let sequence = 0;
    const connectionForThread = vi.fn(() => ({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: `gateway-token-${++sequence}`,
    }));
    const revokeSessionToken = vi.fn();
    const credentials = { connectionForThread, revokeSessionToken };
    const threadId = ThreadId.makeUnsafe("thread-1");

    const previous = acquireAgentGatewaySessionLease(
      credentials,
      threadId,
      "grok",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );
    const replacement = acquireAgentGatewaySessionLease(
      credentials,
      threadId,
      "grok",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    previous?.release();
    expect(revokeSessionToken).toHaveBeenLastCalledWith("gateway-token-1");
    expect(replacement?.connection.bearerToken).toBe("gateway-token-2");

    replacement?.release();
    expect(revokeSessionToken).toHaveBeenCalledTimes(2);
    expect(revokeSessionToken).toHaveBeenLastCalledWith("gateway-token-2");
  });

  it("does not acquire a credential when the gateway layer is absent", () => {
    expect(
      acquireAgentGatewaySessionLease(
        undefined,
        ThreadId.makeUnsafe("thread-1"),
        "droid",
        AGENT_GATEWAY_NO_CAPABILITIES,
      ),
    ).toBeUndefined();
  });

  it("marks the lease released before delegating to a throwing revoker", () => {
    const revokeSessionToken = vi.fn(() => {
      throw new Error("revoke failed");
    });
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "claudeAgent",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    expect(() => lease?.release()).toThrow("revoke failed");
    expect(() => lease?.release()).not.toThrow();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
  });

  it("releases a live lease when the provider exits spontaneously", async () => {
    const providerExited = Deferred.makeUnsafe<void>();
    const revokeSessionToken = vi.fn();
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "cursor",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    await Effect.runPromise(
      startAgentGatewaySessionLeaseExitWatcher(lease, Deferred.await(providerExited)),
    );
    expect(revokeSessionToken).not.toHaveBeenCalled();

    Deferred.doneUnsafe(providerExited, Effect.void);
    await vi.waitFor(() => expect(revokeSessionToken).toHaveBeenCalledOnce());

    lease?.release();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
  });

  it("does not start an exit watcher when no credential was acquired", async () => {
    let awaitedExit = false;

    await Effect.runPromise(
      startAgentGatewaySessionLeaseExitWatcher(
        undefined,
        Effect.sync(() => {
          awaitedExit = true;
        }),
      ),
    );

    expect(awaitedExit).toBe(false);
  });

  it("releases an untransferred lease when provider startup is interrupted", async () => {
    const startupBarrier = Deferred.makeUnsafe<void>();
    const startupEntered = Deferred.makeUnsafe<void>();
    const revokeSessionToken = vi.fn();
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "pi",
      AGENT_GATEWAY_NO_CAPABILITIES,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const startupFiber = yield* releaseAgentGatewaySessionLeaseOnInterrupt(
          lease,
          Deferred.succeed(startupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(startupBarrier)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(startupEntered);
        yield* Fiber.interrupt(startupFiber);
      }),
    );

    expect(revokeSessionToken).toHaveBeenCalledOnce();
    lease?.release();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
  });
});

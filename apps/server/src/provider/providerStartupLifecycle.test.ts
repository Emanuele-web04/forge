import { describe, expect, it, vi } from "vitest";

import { ExecutableNotFoundError } from "@synara/shared/platformProcess";
import {
  ProviderStartupError,
  ProviderStartupLifecycle,
  superviseProviderStartup,
} from "./providerStartupLifecycle";

describe("ProviderStartupLifecycle", () => {
  it("records deterministic startup and ready transitions", async () => {
    const lifecycle = new ProviderStartupLifecycle({ now: () => 1 });

    await expect(
      superviseProviderStartup({
        lifecycle,
        timeoutMs: 100,
        cleanup: async () => undefined,
        start: async ({ markHandshaking, markAuthenticating }) => {
          markHandshaking();
          markAuthenticating();
          return "ready";
        },
      }),
    ).resolves.toBe("ready");

    expect(lifecycle.snapshot()).toMatchObject({
      phase: "ready",
      transitions: [
        { phase: "discovering" },
        { phase: "starting" },
        { phase: "handshaking" },
        { phase: "authenticating" },
        { phase: "ready" },
      ],
    });
  });

  it("turns a missing executable into an immediate explicit failure", async () => {
    const cleanup = vi.fn(async () => undefined);
    const lifecycle = new ProviderStartupLifecycle();

    const failure = await superviseProviderStartup({
      lifecycle,
      timeoutMs: 100,
      cleanup,
      start: async () => {
        throw new ExecutableNotFoundError("provider");
      },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderStartupError);
    expect(failure).toMatchObject({ reason: "ExecutableNotFound" });
    expect(lifecycle.snapshot()).toMatchObject({
      phase: "failed",
      failureReason: "ExecutableNotFound",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("times out a process that starts but never handshakes and cleans it up", async () => {
    const cleanup = vi.fn(async () => undefined);
    const lifecycle = new ProviderStartupLifecycle();

    const failure = await superviseProviderStartup({
      lifecycle,
      timeoutMs: 5,
      cleanup,
      start: async ({ markHandshaking }) => {
        markHandshaking();
        return new Promise<never>(() => undefined);
      },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderStartupError);
    expect(failure).toMatchObject({ reason: "HandshakeTimeout", phase: "handshaking" });
    expect(lifecycle.snapshot()).toMatchObject({
      phase: "failed",
      failureReason: "HandshakeTimeout",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports a startup crash instead of leaving the lifecycle connecting", async () => {
    const cleanup = vi.fn(async () => undefined);

    const failure = await superviseProviderStartup({
      timeoutMs: 100,
      cleanup,
      start: async ({ markHandshaking }) => {
        markHandshaking();
        throw new Error("provider exited during startup");
      },
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ reason: "ExitedDuringStartup" });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cancels while handshaking, performs cleanup once, and stops", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn(async () => undefined);
    const lifecycle = new ProviderStartupLifecycle();

    const result = superviseProviderStartup({
      lifecycle,
      signal: controller.signal,
      timeoutMs: 1_000,
      cleanup,
      start: async ({ markHandshaking }) => {
        markHandshaking();
        return new Promise<never>(() => undefined);
      },
    }).catch((cause: unknown) => cause);
    controller.abort();

    await expect(result).resolves.toMatchObject({ reason: "Cancelled" });
    expect(lifecycle.snapshot()).toMatchObject({
      phase: "stopped",
      failureReason: "Cancelled",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

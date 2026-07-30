import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { ServerConfigShape } from "./config";
import { buildProviderChildEnvironment } from "./providerChildEnvironment";
import {
  authorizeDesktopShutdown,
  isDesktopShutdownLoopbackPeer,
  makeServerShutdownController,
  matchesDesktopShutdownToken,
} from "./serverShutdown";

const SHUTDOWN_TOKEN = "a".repeat(64);
const WRONG_TOKEN = "b".repeat(64);

type ShutdownConfig = Pick<
  ServerConfigShape,
  "mode" | "host" | "publicUrl" | "allowInsecureRemote" | "desktopShutdownToken"
>;

const desktopConfig: ShutdownConfig = {
  mode: "desktop",
  host: "127.0.0.1",
  publicUrl: undefined,
  allowInsecureRemote: false,
  desktopShutdownToken: SHUTDOWN_TOKEN,
};

describe("server shutdown controller", () => {
  it("atomically accepts one request and makes duplicates idempotent", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* makeServerShutdownController();
        const accepted = yield* Effect.all(
          Array.from({ length: 32 }, () => controller.requestStop),
          { concurrency: "unbounded" },
        );
        yield* controller.stopSignal;
        return accepted;
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((accepted) => !accepted)).toHaveLength(31);
  });

  it("keeps controller signals isolated per ServerLive construction", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* makeServerShutdownController();
        const second = yield* makeServerShutdownController();
        const secondWaiter = yield* second.stopSignal.pipe(Effect.forkChild);

        yield* first.requestStop;
        yield* Effect.yieldNow;
        expect(secondWaiter.pollUnsafe()).toBeUndefined();

        yield* second.requestStop;
        yield* Fiber.join(secondWaiter);
      }),
    );
  });
});

describe("desktop shutdown authorization", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts the dedicated token from loopback peer %s",
    (remoteAddress) => {
      expect(
        authorizeDesktopShutdown({
          config: desktopConfig,
          remoteAddress,
          authorization: `Bearer ${SHUTDOWN_TOKEN}`,
        }),
      ).toEqual({ authorized: true });
    },
  );

  it.each([undefined, null, "", "127.0.0.2", "192.168.1.50", "::ffff:192.168.1.50"])(
    "keeps the endpoint unavailable to peer %s",
    (remoteAddress) => {
      expect(
        authorizeDesktopShutdown({
          config: desktopConfig,
          remoteAddress,
          authorization: `Bearer ${SHUTDOWN_TOKEN}`,
        }),
      ).toEqual({ authorized: false, reason: "unavailable", status: 404 });
    },
  );

  it.each([
    ["web mode", { mode: "web" as const }],
    ["a wildcard IPv4 bind", { host: "0.0.0.0" }],
    ["a wildcard IPv6 bind", { host: "::" }],
    ["a non-loopback bind", { host: "192.168.1.50" }],
    ["a public URL", { publicUrl: new URL("https://synara.example.test/") }],
    ["an explicit insecure-remote opt-in", { allowInsecureRemote: true }],
    ["a missing token", { desktopShutdownToken: undefined }],
    ["an empty token", { desktopShutdownToken: "   " }],
  ] satisfies ReadonlyArray<readonly [string, Partial<ShutdownConfig>]>)(
    "keeps the endpoint unavailable for %s",
    (_label, overrides) => {
      expect(
        authorizeDesktopShutdown({
          config: { ...desktopConfig, ...overrides },
          remoteAddress: "127.0.0.1",
          authorization: `Bearer ${SHUTDOWN_TOKEN}`,
        }),
      ).toEqual({ authorized: false, reason: "unavailable", status: 404 });
    },
  );

  it.each([
    undefined,
    "",
    `Basic ${SHUTDOWN_TOKEN}`,
    "Bearer",
    "Bearer ",
    `Bearer  ${SHUTDOWN_TOKEN}`,
    `Bearer ${SHUTDOWN_TOKEN} trailing`,
    `Bearer ${WRONG_TOKEN}`,
  ])("rejects missing, malformed, or wrong Bearer authority: %s", (authorization) => {
    expect(
      authorizeDesktopShutdown({
        config: desktopConfig,
        remoteAddress: "127.0.0.1",
        authorization,
      }),
    ).toEqual({ authorized: false, reason: "unauthorized", status: 401 });
  });

  it("compares fixed-length token digests and recognizes only approved peers", () => {
    expect(matchesDesktopShutdownToken(SHUTDOWN_TOKEN, SHUTDOWN_TOKEN)).toBe(true);
    expect(matchesDesktopShutdownToken(SHUTDOWN_TOKEN, WRONG_TOKEN)).toBe(false);
    expect(matchesDesktopShutdownToken(SHUTDOWN_TOKEN, "short")).toBe(false);
    expect(isDesktopShutdownLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isDesktopShutdownLoopbackPeer("::ffff:127.0.0.2")).toBe(false);
  });

  it("does not grant the shutdown secret to provider descendants", () => {
    const providerEnvironment = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: {
        PATH: process.env.PATH,
        SYNARA_DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
      },
    });

    expect(providerEnvironment.PATH).toBe(process.env.PATH);
    expect(providerEnvironment.SYNARA_DESKTOP_SHUTDOWN_TOKEN).toBeUndefined();
  });
});

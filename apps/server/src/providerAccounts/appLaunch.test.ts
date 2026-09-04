import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountRecord, ProviderAppLaunchPlan } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accountEnvironmentBuilders } from "@synara/shared/providerAccounts/accountEnvironmentBuilders";
import { makeAccountResolver } from "./accountResolver";
import {
  makeAccountStorage,
  ProviderAccountStorageError,
  type AccountStorageShape,
} from "./accountStorage";
import { makeAppLaunch, registerProviderAppLaunchSpec, type AppProcessSpawner } from "./appLaunch";

const connectedAppRecord = (ordinal: number): ProviderAccountRecord => ({
  schemaVersion: 1,
  provider: "cursor",
  ordinal,
  createdAt: "2026-07-24T00:00:00.000Z",
  app: {
    generation: 2,
    state: "connected",
    authMethod: "oauth",
    supportLevel: "beta",
    lastVerifiedAppVersion: "1.4.2",
  },
});

describe("appLaunch", () => {
  let root: string;
  let storage: AccountStorageShape;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-app-launch-"));
    storage = makeAccountStorage({ root });
    await Effect.runPromise(storage.ensureRoot);
    registerProviderAppLaunchSpec("cursor", ({ appDataDir }) => ({
      executable: "/opt/apps/cursor",
      args: ["--user-data-dir", appDataDir],
    }));
  });

  const testEnvironmentBuilders = {
    ...accountEnvironmentBuilders,
    cursor: (input: Parameters<(typeof accountEnvironmentBuilders)["cursor"]>[0]) => ({
      environment: { SYNARA_TEST_SURFACE: input.surface },
      profilePath: input.appDataDir,
    }),
  };

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const makeLaunch = (options?: { spawnProcess?: AppProcessSpawner; now?: () => string }) =>
    makeAppLaunch({
      storage,
      resolver: makeAccountResolver({ storage, environmentBuilders: testEnvironmentBuilders }),
      ...(options?.spawnProcess !== undefined ? { spawnProcess: options.spawnProcess } : {}),
      ...(options?.now !== undefined ? { now: options.now } : {}),
    });

  describe("planAppLaunch", () => {
    it("builds a native account plan with an empty environment", async () => {
      const plan = await Effect.runPromise(makeLaunch().planAppLaunch({ provider: "cursor" }));
      expect(plan).toEqual({
        provider: "cursor",
        ordinal: 0,
        appGeneration: 1,
        executable: "/opt/apps/cursor",
        args: ["--user-data-dir", join(root, "accounts", "cursor", "0", "app", "data")],
        environment: {},
        supportLevel: "supported",
      });
    });

    it("builds a managed account plan with generation, support level, and expected version", async () => {
      await Effect.runPromise(storage.writeAccount(connectedAppRecord(3)));
      const plan = await Effect.runPromise(
        makeLaunch().planAppLaunch({ provider: "cursor", explicitOrdinal: 3 }),
      );
      expect(plan.ordinal).toBe(3);
      expect(plan.appGeneration).toBe(2);
      expect(plan.supportLevel).toBe("unsupported");
      expect(plan.expectedAppVersion).toBe("1.4.2");
      expect(plan.environment).toEqual({ SYNARA_TEST_SURFACE: "app" });
      expect(plan.args).toEqual([
        "--user-data-dir",
        join(root, "accounts", "cursor", "3", "app", "data"),
      ]);
    });

    it("fails when no app launch spec is registered for the provider", async () => {
      const result = await Effect.runPromise(
        Effect.flip(makeLaunch().planAppLaunch({ provider: "grok" })),
      );
      expect(result._tag).toBe("ProviderAppLaunchError");
      expect(result).toMatchObject({ code: "app-launch-unsupported" });
    });

    // unsupported until isolation E2E proof: even a record forced onto disk
    // with a connected app binding must never produce a managed Claude
    // Desktop launch plan.
    it("always refuses managed Claude Desktop launches with the capability error", async () => {
      await import("./claudeAppLaunch");
      await Effect.runPromise(
        storage.writeAccount({
          schemaVersion: 1,
          provider: "claudeAgent",
          ordinal: 2,
          createdAt: "2026-07-24T00:00:00.000Z",
          app: {
            generation: 1,
            state: "connected",
            authMethod: "oauth",
            supportLevel: "unsupported",
          },
        }),
      );
      const result = await Effect.runPromise(
        Effect.flip(makeLaunch().planAppLaunch({ provider: "claudeAgent", explicitOrdinal: 2 })),
      );
      expect(result).toMatchObject({ code: "app-launch-unsupported" });
    });

    it("fails closed for a managed ordinal without a connected app binding", async () => {
      const result = await Effect.runPromise(
        Effect.flip(makeLaunch().planAppLaunch({ provider: "cursor", explicitOrdinal: 7 })),
      );
      expect(result._tag).toBe("ProviderAccountResolutionError");
    });
  });

  describe("launchApp", () => {
    const plan = (overrides?: Partial<ProviderAppLaunchPlan>): ProviderAppLaunchPlan => ({
      provider: "cursor",
      ordinal: 3,
      appGeneration: 2,
      executable: "/opt/apps/cursor",
      args: [],
      environment: {},
      supportLevel: "beta",
      expectedAppVersion: "1.4.2",
      ...overrides,
    });

    it("spawns the app and writes a process lease", async () => {
      const spawnedWith: Array<ProviderAppLaunchPlan> = [];
      const launch = makeLaunch({
        spawnProcess: (input) => {
          spawnedWith.push(input);
          return { pid: 4321 };
        },
        now: () => "2026-07-24T12:00:00.000Z",
      });
      const lease = await Effect.runPromise(launch.launchApp(plan()));
      expect(spawnedWith).toHaveLength(1);
      expect(lease).toEqual({
        provider: "cursor",
        ordinal: 3,
        appGeneration: 2,
        pid: 4321,
        processStartedAt: "2026-07-24T12:00:00.000Z",
        appVersion: "1.4.2",
      });
      expect(await Effect.runPromise(storage.readAppLease("cursor", 3))).toEqual(lease);
    });

    it("fails when the spawned process reports no pid", async () => {
      const launch = makeLaunch({ spawnProcess: () => ({ pid: undefined }) });
      const result = await Effect.runPromise(Effect.flip(launch.launchApp(plan())));
      expect(result).toMatchObject({ code: "spawn-failed" });
    });

    it("fails when spawning throws", async () => {
      const launch = makeLaunch({
        spawnProcess: () => {
          throw new Error("ENOENT");
        },
      });
      const result = await Effect.runPromise(Effect.flip(launch.launchApp(plan())));
      expect(result).toMatchObject({ code: "spawn-failed" });
    });

    it("still launches when the lease write fails", async () => {
      const failingStorage: AccountStorageShape = {
        ...storage,
        writeAppLease: () =>
          Effect.fail(
            new ProviderAccountStorageError({
              operation: "accountStorage.writeAppLease",
              detail: "disk full",
            }),
          ),
      };
      const launch = makeAppLaunch({
        storage: failingStorage,
        resolver: makeAccountResolver({
          storage: failingStorage,
          environmentBuilders: testEnvironmentBuilders,
        }),
        spawnProcess: () => ({ pid: 99 }),
      });
      const lease = await Effect.runPromise(launch.launchApp(plan()));
      expect(lease.pid).toBe(99);
    });

    it("launches a real detached process with the default spawner", async () => {
      const launch = makeLaunch();
      const lease = await Effect.runPromise(
        launch.launchApp(
          plan({
            executable: process.execPath,
            args: ["-e", "setTimeout(() => {}, 50)"],
          }),
        ),
      );
      expect(lease.pid).toBeGreaterThan(0);
      expect(await Effect.runPromise(storage.readAppLease("cursor", 3))).toEqual(lease);
    });
  });
});

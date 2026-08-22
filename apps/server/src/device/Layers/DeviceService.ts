/**
 * DeviceServiceLive - one DeviceManager for the server process.
 *
 * The manager exists on every platform so no caller has to branch on `null`;
 * off darwin its backend reports `unsupported-platform` and every device call
 * fails cleanly through the same path a missing Xcode would take. `supported`
 * is what callers use to decide whether to expose the surface at all.
 *
 * @module device/Layers/DeviceService
 */
import { Effect, Layer } from "effect";
import { homedir } from "node:os";
import * as path from "node:path";

import { makeBootOwnershipStore, NULL_BOOT_OWNERSHIP } from "../bootOwnership.ts";
import { DeviceManager } from "../DeviceManager.ts";
import { IosSimulatorBackend } from "../IosSimulatorBackend.ts";
import { DeviceService, type DeviceServiceShape } from "../Services/DeviceService.ts";

export interface DeviceServiceLiveOptions {
  readonly platform?: NodeJS.Platform;
  /** Where to remember this run's boots; omit to remember nothing. */
  readonly bootOwnershipPath?: string;
}

/**
 * Where the boot record lives, derived the way the server derives its state
 * directory so both land in the same place under a custom SYNARA_HOME.
 *
 * Resolved here rather than taken from ServerConfig because this layer is built
 * before that config is in scope, and getting the path wrong only costs the
 * crash-recovery, not the feature.
 */
function defaultBootOwnershipPath(): string {
  const baseDir = process.env.SYNARA_HOME?.trim() || path.join(homedir(), ".synara");
  const stateDir = path.join(baseDir, process.env.VITE_DEV_SERVER_URL ? "dev" : "userdata");
  return path.join(stateDir, "device-boot-ownership.json");
}

export function makeDeviceServiceLayer(options: DeviceServiceLiveOptions = {}) {
  return Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const backend = new IosSimulatorBackend({ platform });
      // Only darwin can boot anything, so only darwin needs to remember doing so.
      const bootOwnership =
        platform === "darwin"
          ? makeBootOwnershipStore(options.bootOwnershipPath ?? defaultBootOwnershipPath())
          : NULL_BOOT_OWNERSHIP;
      const manager = new DeviceManager({ backend, bootOwnership });

      // A previous run that crashed left its simulators booted and no longer
      // owned by anyone: reclaim them before this run starts counting boots,
      // or they linger forever outside the cap and the idle sweep.
      if (platform === "darwin") {
        yield* Effect.promise(async () => {
          const reclaimed = await manager.reclaimOrphanedBoots().catch(() => []);
          if (reclaimed.length > 0) {
            console.info(
              `[device] shut down ${reclaimed.length} simulator(s) left booted by a previous ` +
                `Synara run: ${reclaimed.join(", ")}`,
            );
          }
        });
      }

      // App quit shuts down every simulator Synara booted and leaves the
      // user's own devices running.
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      return { supported: platform === "darwin", manager } satisfies DeviceServiceShape;
    }),
  );
}

export const DeviceServiceLive = makeDeviceServiceLayer();

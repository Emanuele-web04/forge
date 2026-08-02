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

import { DeviceManager } from "../DeviceManager.ts";
import { IosSimulatorBackend } from "../IosSimulatorBackend.ts";
import { DeviceService, type DeviceServiceShape } from "../Services/DeviceService.ts";

export interface DeviceServiceLiveOptions {
  readonly platform?: NodeJS.Platform;
}

export function makeDeviceServiceLayer(options: DeviceServiceLiveOptions = {}) {
  return Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const backend = new IosSimulatorBackend({ platform });
      const manager = new DeviceManager({ backend });
      // App quit shuts down every simulator Synara booted and leaves the
      // user's own devices running.
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      return { supported: platform === "darwin", manager } satisfies DeviceServiceShape;
    }),
  );
}

export const DeviceServiceLive = makeDeviceServiceLayer();

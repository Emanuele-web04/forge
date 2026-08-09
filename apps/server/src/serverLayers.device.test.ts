import { describe, expect, it } from "vitest";
import { Effect, Layer, ServiceMap } from "effect";

import { DeviceManager } from "./device/DeviceManager";
import { FakeDeviceBackend } from "./device/FakeDeviceBackend";
import { DeviceService } from "./device/Services/DeviceService";
import { detachThreadDevice } from "./orchestration/Layers/ThreadDeletionReactor";
import { provideThreadDeletionReactorDeviceService } from "./serverLayers";

class ThreadDeletionDeviceProbe extends ServiceMap.Service<
  ThreadDeletionDeviceProbe,
  { readonly manager: DeviceManager }
>()("test/ThreadDeletionDeviceProbe") {}

describe("thread deletion reactor device-service wiring", () => {
  it("feeds the same DeviceService instance into lifecycle cleanup", async () => {
    const threadId = "thread-delete-layer-wiring";
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    await backend.boot("FAKE-0001");
    await manager.attach(threadId, "FAKE-0001");

    const deviceServiceLayer = Layer.succeed(DeviceService, { supported: true, manager });
    const deletionProbeLayer = Layer.effect(
      ThreadDeletionDeviceProbe,
      Effect.gen(function* () {
        const deviceService = yield* Effect.service(DeviceService);
        yield* detachThreadDevice(threadId);
        return { manager: deviceService.manager };
      }),
    );
    const wiredLayer = provideThreadDeletionReactorDeviceService(
      deletionProbeLayer,
      deviceServiceLayer,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const probe = yield* ThreadDeletionDeviceProbe;
        const service = yield* Effect.service(DeviceService);
        return { probe, service };
      }).pipe(Effect.provide(wiredLayer)),
    );

    expect(result.probe.manager).toBe(result.service.manager);
    expect((await manager.getThreadState(threadId)).attachedDeviceUdid).toBeNull();
    expect(backend.hasStream("FAKE-0001")).toBe(false);
  });
});

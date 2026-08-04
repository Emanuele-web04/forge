import { describe, expect, it } from "vitest";

import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";

describe("stale stream errors", () => {
  it("clears an attach failure once the stream actually starts", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    const device = (await backend.listDevices({ includeShutdown: true }))[0]!;
    await backend.boot(device.udid);

    // A device still publishing its display refuses the first attach; the
    // message must not outlive the stream that follows it.
    backend.failNextStream("display has no framebuffer surface yet");
    const failed = await manager.attach(THREAD, device.udid);
    expect(failed.lastError).toContain("framebuffer");

    await manager.detach(THREAD);
    const recovered = await manager.attach(THREAD, device.udid);
    expect(recovered.lastError).toBeNull();
  });
});

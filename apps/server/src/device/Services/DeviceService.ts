import { ServiceMap } from "effect";

import type { DeviceManager } from "../DeviceManager.ts";

export interface DeviceServiceShape {
  /**
   * True only where a device backend can actually exist (macOS today). Off
   * darwin the manager still answers, but every call reports
   * `unsupported-platform`, and callers use this to hide the surface entirely
   * rather than offering an agent eleven tools that cannot work.
   */
  readonly supported: boolean;
  readonly manager: DeviceManager;
}

export class DeviceService extends ServiceMap.Service<DeviceService, DeviceServiceShape>()(
  "synara/device/Services/DeviceService",
) {}

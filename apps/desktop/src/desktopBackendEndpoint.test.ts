import { describe, expect, it, vi } from "vitest";

import { parseDesktopBackendPort, resolveDesktopBackendPort } from "./desktopBackendEndpoint";

describe("desktop backend endpoint", () => {
  it("keeps random loopback allocation when SYNARA_PORT is unset", async () => {
    const reserveLoopbackPort = vi.fn(async () => 49_123);
    const isPortAvailableOnLoopback = vi.fn(async () => true);

    await expect(
      resolveDesktopBackendPort(undefined, {
        reserveLoopbackPort,
        isPortAvailableOnLoopback,
      }),
    ).resolves.toBe(49_123);
    expect(reserveLoopbackPort).toHaveBeenCalledOnce();
    expect(isPortAvailableOnLoopback).not.toHaveBeenCalled();
  });

  it("uses an available explicit SYNARA_PORT without allocating a fallback", async () => {
    const reserveLoopbackPort = vi.fn(async () => 49_123);
    const isPortAvailableOnLoopback = vi.fn(async () => true);

    await expect(
      resolveDesktopBackendPort("3773", {
        reserveLoopbackPort,
        isPortAvailableOnLoopback,
      }),
    ).resolves.toBe(3773);
    expect(isPortAvailableOnLoopback).toHaveBeenCalledWith(3773);
    expect(reserveLoopbackPort).not.toHaveBeenCalled();
  });

  it("fails clearly instead of changing an occupied explicit port", async () => {
    const reserveLoopbackPort = vi.fn(async () => 49_123);

    await expect(
      resolveDesktopBackendPort("3773", {
        reserveLoopbackPort,
        isPortAvailableOnLoopback: async () => false,
      }),
    ).rejects.toThrow(
      "SYNARA_PORT 3773 is unavailable on loopback. Stop the process using that port or configure a different fixed port.",
    );
    expect(reserveLoopbackPort).not.toHaveBeenCalled();
  });

  it.each(["", "0", "65536", "1.5", "not-a-port"])(
    "rejects invalid SYNARA_PORT value %j",
    (value) => {
      expect(() => parseDesktopBackendPort(value)).toThrow(
        "Expected an integer from 1 through 65535.",
      );
    },
  );

  it("accepts both ends of the valid port range", () => {
    expect(parseDesktopBackendPort("1")).toBe(1);
    expect(parseDesktopBackendPort("65535")).toBe(65_535);
  });
});

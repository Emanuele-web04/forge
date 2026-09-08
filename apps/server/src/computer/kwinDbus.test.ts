import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_OBJECT_PATH,
  COMPUTER_SERVICE,
  createSessionKWinComputerDbus,
  invokeKWinDbusMethod,
  KWIN_DBUS_CAPTURE_TIMEOUT_MS,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  KWinDbusTimeoutError,
  readStringArray,
} from "./kwinDbus.ts";

describe("KWin D-Bus calls", () => {
  it("times out ordinary and capture calls at their separate limits", async () => {
    vi.useFakeTimers();
    try {
      let ordinarySettled = false;
      const ordinary = invokeKWinDbusMethod(
        { stateJson: () => new Promise(() => undefined) },
        "stateJson",
      );
      ordinary.then(
        () => {
          ordinarySettled = true;
        },
        () => {
          ordinarySettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(KWIN_DBUS_DEFAULT_TIMEOUT_MS - 1);
      expect(ordinarySettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(ordinary).rejects.toBeInstanceOf(KWinDbusTimeoutError);

      let captureSettled = false;
      const capture = invokeKWinDbusMethod(
        { captureWindow: () => new Promise(() => undefined) },
        "captureWindow",
      );
      capture.then(
        () => {
          captureSettled = true;
        },
        () => {
          captureSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(KWIN_DBUS_CAPTURE_TIMEOUT_MS - 1);
      expect(captureSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(capture).rejects.toBeInstanceOf(KWinDbusTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when a call settles", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        invokeKWinDbusMethod({ stateJson: () => Promise.resolve("ok") }, "stateJson"),
      ).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a failure KWin reported through untouched", async () => {
    // Only a timeout is connection-level. A call KWin answered with an error
    // says nothing about the connection, so wrapping it in the type that drives
    // a reconnect would tear down a session over a bad argument.
    const reported = new Error("org.freedesktop.DBus.Error.InvalidArgs");
    await expect(
      invokeKWinDbusMethod({ focusWindow: () => Promise.reject(reported) }, "focusWindow"),
    ).rejects.toBe(reported);
  });

  it("keeps a one-element loaded plugin array as an array", () => {
    expect(readStringArray(["onlyPlugin"])).toEqual(["onlyPlugin"]);
    expect(readStringArray({ signature: "as", value: ["onlyPlugin"] })).toEqual(["onlyPlugin"]);
  });
});

describe("connectPlugin owner pinning", () => {
  // A proxy addressed by the well-known name follows the name to whoever owns
  // it next, so a squatter or stale generation taking the name after the
  // backend's ownership check would receive every input and capture call.
  // These pin the proxy's destination to the unique name resolved at connect.
  function fakeBus(options: { readonly owner?: string }) {
    const proxied: string[] = [];
    const bus = {
      proxied,
      getProxyObject: (service: string) => {
        proxied.push(service);
        return Promise.resolve({
          getInterface: () => ({
            GetNameOwner: (name: string) => {
              if (options.owner === undefined) {
                return Promise.reject(
                  new Error("org.freedesktop.DBus.Error.NameHasNoOwner: no owner"),
                );
              }
              return Promise.resolve(name === COMPUTER_SERVICE ? options.owner : ":0.0");
            },
          }),
        });
      },
      disconnect: () => undefined,
      on: () => bus,
      off: () => bus,
    };
    return bus;
  }

  it("addresses the plugin proxy by the resolved unique name, not the well-known one", async () => {
    const bus = fakeBus({ owner: ":1.42" });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
    });
    await dbus.connectPlugin();

    expect(bus.proxied.at(-1)).toBe(":1.42");
    expect(bus.proxied).not.toContain(COMPUTER_SERVICE);
    expect(bus.proxied.filter((service) => service === COMPUTER_OBJECT_PATH)).toEqual([]);
    await dbus.close();
  });

  it("refuses to connect when nothing owns the service name", async () => {
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => fakeBus({}) as never },
    });

    await expect(dbus.connectPlugin()).rejects.toThrow(/Nothing on the session bus owns/);
    await dbus.close();
  });
});

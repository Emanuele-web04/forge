import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";
import type { ProxyObject as DbusProxyObject } from "dbus-next";

import { unwrapDbusValue, withDbusTimeout } from "./dbusPlumbing.ts";

export const KWIN_SERVICE = "org.kde.KWin";
export const KWIN_PLUGINS_PATH = "/Plugins";
export const KWIN_PLUGINS_INTERFACE = "org.kde.KWin.Plugins";
export const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
export const DBUS_SERVICE = "org.freedesktop.DBus";
export const DBUS_OBJECT_PATH = "/org/freedesktop/DBus";
export const DBUS_INTERFACE = "org.freedesktop.DBus";
export const COMPUTER_SERVICE = "org.synara.ComputerUse";
export const COMPUTER_OBJECT_PATH = "/org/synara/ComputerUse";
export const COMPUTER_INTERFACE = "org.synara.ComputerUse1";
export const KWIN_DBUS_DEFAULT_TIMEOUT_MS = 5_000;
export const KWIN_DBUS_CAPTURE_TIMEOUT_MS = 10_000;

export class KWinDbusTimeoutError extends Error {
  readonly connectionLevel = true;
  readonly methodName: string;
  readonly timeoutMs: number;

  constructor(methodName: string, timeoutMs: number) {
    super(`D-Bus call ${methodName} timed out after ${timeoutMs} ms.`);
    this.name = "KWinDbusTimeoutError";
    this.methodName = methodName;
    this.timeoutMs = timeoutMs;
  }
}

export interface KWinComputerPluginApi {
  readonly healthJson: () => Promise<unknown>;
  readonly stateJson: () => Promise<unknown>;
  readonly windowsJson: () => Promise<unknown>;
  readonly start: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly setIdleTimeout: (milliseconds: number) => Promise<unknown>;
  /**
   * How recently the human's own seat must have been active for the plugin to
   * refuse a mutating action aimed at the window they are focused on. `0`
   * disables the guard. Absent on plugin builds older than Phase 4.
   */
  readonly setHumanActiveGuardMs: (milliseconds: number) => Promise<unknown>;
  /** Names the thread driving the ghost cursor, for the on-screen badge. */
  readonly setAgentName: (name: string) => Promise<unknown>;
  readonly focusWindow: (windowId: string) => Promise<unknown>;
  readonly raiseWindow: (windowId: string) => Promise<unknown>;
  readonly clearFocusWindow: () => Promise<unknown>;
  readonly movePointer: (x: number, y: number) => Promise<unknown>;
  readonly button: (code: number, pressed: boolean) => Promise<unknown>;
  /**
   * Scroll distance in logical pixels on each axis, the same unit as pointer
   * coordinates and window bounds — not wheel notches or lines. One unit is one
   * pixel of content, so a wheel notch is on the order of a hundred. The plugin
   * consumes the same unit, and the agent tool surface documents it, so a delta
   * means the same thing at every hop.
   */
  readonly axis: (horizontal: number, vertical: number) => Promise<unknown>;
  readonly key: (code: number, pressed: boolean) => Promise<unknown>;
  readonly captureWindow: (windowId: string, maxDimension: number) => Promise<unknown>;
  readonly captureRegion: (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => Promise<unknown>;
}

export interface KWinComputerDbus {
  readonly listLoadedPluginIds: () => Promise<readonly string[]>;
  readonly loadPlugin: (pluginId: string) => Promise<boolean>;
  /** `false` only when KWin reports the id was not loaded to begin with. */
  readonly unloadPlugin: (pluginId: string) => Promise<boolean>;
  /**
   * The unique bus name of whoever owns `name`, or `undefined` when nothing
   * does. This is how a well-known name is pinned to the process that answered
   * it *now*: talking to whichever process holds `org.synara.ComputerUse`
   * without checking means a stale duplicate instance silently receives every
   * pointer, key, and capture call.
   */
  readonly nameOwner: (name: string) => Promise<string | undefined>;
  readonly connectPlugin: () => Promise<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface KWinComputerDbusOptions {
  /** Tests inject a fake here; production resolves the real dbus-next. */
  readonly dbusModule?: Pick<typeof dbusModule, "sessionBus">;
}

/**
 * The session bus itself and the Synara plugin proxy on it. The KWin host adds
 * KWin's D-Bus plugin manager on top.
 */
export interface ComputerSessionBus {
  /** Resolves a proxy object, with the shared connection-level timeout. */
  readonly getProxyObject: (service: string, path: string) => Promise<DbusProxyObject>;
  /** The unique bus name owning `name`, or undefined when nobody does. */
  readonly nameOwner: (name: string) => Promise<string | undefined>;
  /**
   * Connects to the Synara plugin by its owner's *unique* name, never the
   * well-known one; requires the service to be owned right now.
   */
  readonly connectPlugin: () => Promise<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
}

/**
 * Connect to a session bus, wired for plugin-host use: disconnect fan-out, the
 * Synara plugin proxy, and idempotent close. The plugin proxy is resolved only
 * after the backend has selected and loaded an installed plugin, because no
 * compositor owns the Synara service until a plugin has been loaded.
 */
export async function openComputerSessionBus(
  options: KWinComputerDbusOptions = {},
): Promise<ComputerSessionBus> {
  // Keep the optional Linux runtime out of test imports. The production path
  // resolves it only when the backend has passed the Linux/Wayland gate.
  const require = createRequire(import.meta.url);
  const dbus = options.dbusModule ?? (require("dbus-next") as typeof dbusModule);
  const bus = dbus.sessionBus();
  let closed = false;
  const disconnectListeners = new Set<() => void>();
  const onDisconnectEvent = () => {
    for (const listener of disconnectListeners) listener();
  };
  const eventBus = bus as unknown as EventEmitter;
  eventBus.on("disconnect", onDisconnectEvent);
  eventBus.on("error", onDisconnectEvent);
  let busDaemon: DbusProxyObject;
  try {
    busDaemon = await withTimeout(
      Promise.resolve(bus.getProxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH)),
      KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      "getProxyObject",
    );
  } catch (error) {
    eventBus.off("disconnect", onDisconnectEvent);
    eventBus.off("error", onDisconnectEvent);
    bus.disconnect();
    throw error;
  }
  const daemon = busDaemon.getInterface(DBUS_INTERFACE);
  const resolveNameOwner = async (name: string): Promise<string | undefined> => {
    try {
      const owner = await invoke(daemon, "GetNameOwner", name);
      return typeof unwrapDbusValue(owner) === "string"
        ? (unwrapDbusValue(owner) as string)
        : undefined;
    } catch (error) {
      // "Nobody owns it" is an answer, not a failure: the caller is the
      // one deciding whether an owner was required.
      if (isUnownedNameError(error)) return undefined;
      throw error;
    }
  };
  return {
    getProxyObject: (service, path) =>
      withTimeout(
        Promise.resolve(bus.getProxyObject(service, path)),
        KWIN_DBUS_DEFAULT_TIMEOUT_MS,
        "getProxyObject",
      ),
    nameOwner: resolveNameOwner,
    connectPlugin: async () => {
      // Address the proxy by the owner's *unique* name, not the well-known
      // one. dbus-next routes every later call by the proxy's destination, so
      // a proxy addressed as `org.synara.ComputerUse` follows the name to
      // whoever owns it next — a stale generation or a same-session squatter
      // taking the name after the backend's ownership check would silently
      // receive every pointer, key, and capture call. Pinned to the unique
      // name, a replaced owner makes calls fail loudly instead, and the
      // reconnect path re-resolves the fresh owner from scratch.
      const owner = await resolveNameOwner(COMPUTER_SERVICE);
      if (owner === undefined) {
        throw new Error(
          `Nothing on the session bus owns ${COMPUTER_SERVICE}, so the plugin cannot be connected.`,
        );
      }
      const object = await withTimeout(
        Promise.resolve(bus.getProxyObject(owner, COMPUTER_OBJECT_PATH)),
        KWIN_DBUS_DEFAULT_TIMEOUT_MS,
        "getProxyObject",
      );
      const plugin = object.getInterface(COMPUTER_INTERFACE);
      return makePluginApi(plugin);
    },
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      disconnectListeners.clear();
      eventBus.off("disconnect", onDisconnectEvent);
      eventBus.off("error", onDisconnectEvent);
      bus.disconnect();
    },
  };
}

/**
 * Connect to a session bus and KWin's plugin manager.
 */
export async function createSessionKWinComputerDbus(
  options: KWinComputerDbusOptions = {},
): Promise<KWinComputerDbus> {
  const session = await openComputerSessionBus(options);
  try {
    const pluginsObject = await session.getProxyObject(KWIN_SERVICE, KWIN_PLUGINS_PATH);
    const plugins = pluginsObject.getInterface(KWIN_PLUGINS_INTERFACE);
    // KWin exposes the loaded plugin list as the LoadedPlugins property (KWin 6
    // has no loadedPlugins method); keep the method as a fallback for variants
    // that only offer it.
    let properties: unknown;
    try {
      properties = pluginsObject.getInterface(DBUS_PROPERTIES_INTERFACE);
    } catch {
      properties = undefined;
    }
    return {
      nameOwner: session.nameOwner,
      listLoadedPluginIds: async () => {
        const result = properties
          ? await invoke(properties, "Get", KWIN_PLUGINS_INTERFACE, "LoadedPlugins")
          : await invoke(plugins, "loadedPlugins");
        return readStringArray(result);
      },
      loadPlugin: async (pluginId) => {
        const result = await invoke(plugins, "LoadPlugin", pluginId);
        return readBoolean(result);
      },
      unloadPlugin: async (pluginId) => {
        // KWin's UnloadPlugin reply differs by version: older builds answer
        // `b`, newer ones are void. A void reply means the call succeeded, so
        // only an explicit `false` reports "was not loaded".
        const result = await invoke(plugins, "UnloadPlugin", pluginId);
        return readOptionalBoolean(result) ?? true;
      },
      connectPlugin: session.connectPlugin,
      onDisconnect: session.onDisconnect,
      close: session.close,
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

function isUnownedNameError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("NameHasNoOwner") || text.includes("ServiceUnknown");
}

function makePluginApi(iface: unknown): KWinComputerPluginApi {
  return {
    healthJson: () => invoke(iface, "healthJson"),
    stateJson: () => invoke(iface, "stateJson"),
    windowsJson: () => invoke(iface, "windowsJson"),
    start: () => invoke(iface, "start"),
    stop: () => invoke(iface, "stop"),
    setIdleTimeout: (milliseconds) => invoke(iface, "setIdleTimeout", milliseconds),
    setHumanActiveGuardMs: (milliseconds) => invoke(iface, "setHumanActiveGuardMs", milliseconds),
    setAgentName: (name) => invoke(iface, "setAgentName", name),
    focusWindow: (windowId) => invoke(iface, "focusWindow", windowId),
    raiseWindow: (windowId) => invoke(iface, "raiseWindow", windowId),
    clearFocusWindow: () => invoke(iface, "clearFocusWindow"),
    movePointer: (x, y) => invoke(iface, "movePointer", x, y),
    button: (code, pressed) => invoke(iface, "button", code, pressed),
    axis: (horizontal, vertical) => invoke(iface, "axis", horizontal, vertical),
    key: (code, pressed) => invoke(iface, "key", code, pressed),
    captureWindow: (windowId, maxDimension) =>
      invoke(iface, "captureWindow", windowId, maxDimension),
    captureRegion: (x, y, width, height, maxDimension) =>
      invoke(iface, "captureRegion", x, y, width, height, maxDimension),
  };
}

export async function invokeKWinDbusMethod(
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  if (typeof iface !== "object" || iface === null) {
    throw new Error(`D-Bus interface ${methodName} is unavailable.`);
  }
  const method = (iface as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`D-Bus method ${methodName} is unavailable.`);
  }
  const result = (method as (...callArgs: readonly unknown[]) => Promise<unknown>)(...args);
  return await withTimeout(
    Promise.resolve(result),
    isCaptureMethod(methodName) ? KWIN_DBUS_CAPTURE_TIMEOUT_MS : KWIN_DBUS_DEFAULT_TIMEOUT_MS,
    methodName,
  );
}

const invoke = invokeKWinDbusMethod;

function isCaptureMethod(methodName: string): boolean {
  return methodName === "captureWindow" || methodName === "captureRegion";
}

/**
 * A KWin call that never answers is connection-level: `KWinDbusTimeoutError` is
 * what the backend reads to decide the plugin proxy is gone and reconnect, so
 * the type matters as much as the message. Failures KWin does report travel
 * untouched, being already about the call rather than the connection.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, methodName: string): Promise<T> {
  return withDbusTimeout(promise, timeoutMs, {
    onTimeout: () => new KWinDbusTimeoutError(methodName, timeoutMs),
  });
}

function readBoolean(value: unknown): boolean {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped !== "boolean") {
    throw new Error("KWin returned a non-boolean plugin result.");
  }
  return unwrapped;
}

/** `undefined` for the void reply a KWin build without a return value sends. */
export function readOptionalBoolean(value: unknown): boolean | undefined {
  const unwrapped = unwrapDbusValue(value);
  return typeof unwrapped === "boolean" ? unwrapped : undefined;
}

export function readStringArray(value: unknown): readonly string[] {
  const unwrapped = unwrapDbusValue(value);
  if (!Array.isArray(unwrapped) || !unwrapped.every((item) => typeof item === "string")) {
    throw new Error("KWin returned an invalid loaded plugin list.");
  }
  return unwrapped;
}

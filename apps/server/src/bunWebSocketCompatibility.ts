import { NodeWS } from "@effect/platform-node/NodeSocket";

type CloseEventLike = {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
};
type ListenerObject = { handleEvent: (event: CloseEventLike) => void };
type ListenerFunction = (event: CloseEventLike) => void;
type RawListenerFunction = (...args: ReadonlyArray<unknown>) => void;
type Listener = ListenerFunction | ListenerObject | null;
type RawListener = ListenerObject | RawListenerFunction | null;
type ListenerOptions = boolean | { readonly once?: boolean; readonly passive?: boolean };
type CloseEventTarget = {
  addEventListener: (type: string, listener: RawListener, options?: ListenerOptions) => void;
  removeEventListener: (type: string, listener: RawListener, options?: ListenerOptions) => void;
};

const PATCHED = Symbol.for("synara.bunWebSocketCloseEventPatched");

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function normalizeCloseEvent(first: unknown, second: unknown) {
  if (first && typeof first === "object" && "code" in first) {
    return first as CloseEventLike;
  }

  return {
    code: typeof first === "number" ? first : 1005,
    reason:
      typeof second === "string" ? second : second instanceof Buffer ? second.toString("utf8") : "",
    wasClean: true,
  } satisfies CloseEventLike;
}

export function patchBunWebSocketCloseEventCompatibility() {
  if (!isBunRuntime()) return;

  const serverPrototype = NodeWS.WebSocketServer.prototype as NodeWS.WebSocketServer & {
    readonly [PATCHED]?: true;
    handleUpgrade: NodeWS.WebSocketServer["handleUpgrade"];
  };
  if (serverPrototype[PATCHED]) return;

  const originalHandleUpgrade = serverPrototype.handleUpgrade;
  serverPrototype.handleUpgrade = function patchedHandleUpgrade(
    this: NodeWS.WebSocketServer,
    request,
    socket,
    head,
    callback,
  ) {
    return originalHandleUpgrade.call(this, request, socket, head, (ws) => {
      patchCloseEventTarget(ws as unknown as CloseEventTarget);
      callback(ws, request);
    });
  } as NodeWS.WebSocketServer["handleUpgrade"];

  Object.defineProperty(serverPrototype, PATCHED, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}

export function patchCloseEventTarget(target: CloseEventTarget) {
  const socket = target as CloseEventTarget & { readonly [PATCHED]?: true };
  if (socket[PATCHED]) return;

  const originalAddEventListener = socket.addEventListener;
  const originalRemoveEventListener = socket.removeEventListener;
  const wrappedCloseListeners = new WeakMap<object, (first: unknown, second: unknown) => void>();

  socket.addEventListener = function patchedAddEventListener(
    type: string,
    listener: Listener,
    options?: ListenerOptions,
  ) {
    if (type !== "close" || !listener) {
      return originalAddEventListener.call(this, type, listener as RawListener, options);
    }

    const listenerKey: object = listener;
    let wrapped = wrappedCloseListeners.get(listenerKey);
    if (!wrapped) {
      wrapped = function patchedCloseListener(this: WebSocket, first: unknown, second: unknown) {
        const event = normalizeCloseEvent(first, second);
        if (typeof listener === "function") {
          listener.call(this, event);
          return;
        }
        listener.handleEvent(event);
      };
      wrappedCloseListeners.set(listenerKey, wrapped);
    }

    return originalAddEventListener.call(this, type, wrapped, options);
  };

  socket.removeEventListener = function patchedRemoveEventListener(
    type: string,
    listener: Listener,
    options?: ListenerOptions,
  ) {
    if (type !== "close" || !listener) {
      return originalRemoveEventListener.call(this, type, listener as RawListener, options);
    }

    const listenerKey: object = listener;
    return originalRemoveEventListener.call(
      this,
      type,
      (wrappedCloseListeners.get(listenerKey) ?? listener) as RawListener,
      options,
    );
  };

  Object.defineProperty(socket, PATCHED, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}

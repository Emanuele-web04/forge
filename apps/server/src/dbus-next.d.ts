declare module "dbus-next" {
  export interface DbusBus {
    getProxyObject(service: string, path: string): Promise<DbusProxyObject>;
    /**
     * Send a message and wait for its reply, for callers that need to subscribe
     * to a signal before the call goes out — an ordering the proxy API cannot
     * express.
     */
    call(message: Message): Promise<Message | null>;
    on(event: "error" | "disconnect", listener: (...args: readonly unknown[]) => void): void;
    off?(event: "error" | "disconnect", listener: (...args: readonly unknown[]) => void): void;
    disconnect(): void;
  }

  interface DbusProxyObject {
    getInterface(name: string): unknown;
  }

  export function sessionBus(options?: Record<string, unknown>): DbusBus;

  // `Message` and `Variant` come from the package's own types.d.ts, which this
  // declaration merges with; they are named here so the default import carries
  // them, since that file declares no default export.
  const dbus: {
    readonly sessionBus: typeof sessionBus;
    readonly Message: typeof Message;
    readonly Variant: typeof Variant;
  };
  export default dbus;
}

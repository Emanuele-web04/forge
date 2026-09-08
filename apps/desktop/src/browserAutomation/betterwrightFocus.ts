import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

/** The manager only leases guests attached to Synara's trusted owning renderer. */
export async function withRendererGuestFocus<T>(
  contents: WebContents,
  operation: () => Promise<T>,
): Promise<T> {
  if (contents.getType() !== "webview") return operation();
  const host = contents.hostWebContents;
  if (!host || host.isDestroyed() || !Number.isSafeInteger(contents.id))
    throw new Error("Browser focus unavailable.");
  const key = JSON.stringify(`synara-browser-focus-${randomUUID()}`);
  try {
    // Never interpolate model input into the privileged renderer. The only
    // arguments are a native WebContents ID and a one-use restoration key.
    const focused = await host.executeJavaScript(`(() => {
      const guests = Array.from(document.querySelectorAll("webview")).filter(element => {
        try { return element.isConnected && element.getWebContentsId() === ${contents.id}; }
        catch { return false; }
      });
      if (guests.length !== 1) return false;
      const guest = guests[0];
      const previous = document.activeElement;
      globalThis[${key}] = () => {
        delete globalThis[${key}];
        if (document.activeElement === guest && previous?.isConnected)
          previous.focus({preventScroll:true});
      };
      guest.focus();
      return document.activeElement === guest;
    })()`);
    if (focused !== true || contents.isDestroyed() || contents.hostWebContents !== host)
      throw new Error("Browser focus unavailable.");
    return await operation();
  } finally {
    if (!host.isDestroyed())
      // Cleanup must never mask the operation's own error or lease diagnostics.
      await host.executeJavaScript(`globalThis[${key}]?.()`).catch(() => {});
  }
}

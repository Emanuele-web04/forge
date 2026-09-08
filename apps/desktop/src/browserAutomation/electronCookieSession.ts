import { WebContentsView } from "electron";
import type { CookieSessionBackend } from "./browserSessionRestore";

export function createCookieSessionBackend(partition: string): CookieSessionBackend {
  // This never navigates to a website, joins the UI, or accepts agent commands.
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = view.webContents;
  contents.debugger.attach("1.3");
  const ready = contents.loadURL("about:blank");
  const changedListeners = new Set<() => void>();
  return {
    async read() {
      await ready;
      // Electron's browser-scoped Storage domain resolves the default profile,
      // not this view's partition. Use the target-scoped Network commands.
      const result = await view.webContents.debugger.sendCommand("Network.getAllCookies");
      return result.cookies;
    },
    async restore(cookies) {
      await ready;
      if (cookies.length)
        await view.webContents.debugger.sendCommand("Network.setCookies", { cookies });
    },
    onChange(listener) {
      contents.session.cookies.on("changed", listener);
      changedListeners.add(listener);
    },
    dispose() {
      // The partition session outlives this view; a stale listener would fire
      // the restore path against a closed backend.
      for (const listener of changedListeners)
        contents.session.cookies.removeListener("changed", listener);
      changedListeners.clear();
      if (!view.webContents.isDestroyed()) view.webContents.close();
    },
  };
}

// FILE: floatingBrowserChromePreload.ts
// Purpose: Lets the floating-card chrome webview talk to its embedder.
// Layer: Desktop webview preload
// Depends on: Electron contextBridge

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("synaraFloatingChrome", {
  send(type: string, payload?: unknown) {
    ipcRenderer.sendToHost(type, payload ?? null);
  },
  onHost(listener: (payload: unknown) => void) {
    ipcRenderer.on("synara-floating-chrome-host", (_event, payload: unknown) => {
      listener(payload);
    });
  },
});

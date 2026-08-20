import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  BrowserAnnotationEvent,
  BrowserUseOpenPanelRequest,
  DesktopBridge,
} from "@synara/contracts";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const IPC = DESKTOP_IPC_CHANNELS;

function getDesktopWsUrl(): string | null {
  try {
    const ipcWsUrl = normalizeDesktopWsUrl(ipcRenderer.sendSync(IPC.wsUrl));
    return ipcWsUrl ?? resolveDesktopWsUrlFromEnv(process.env);
  } catch {
    return resolveDesktopWsUrlFromEnv(process.env);
  }
}

function parseBrowserOpenPanelRequest(payload: unknown): BrowserUseOpenPanelRequest | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const threadId = (payload as { readonly threadId?: unknown }).threadId;
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    return null;
  }
  return { threadId: threadId as BrowserUseOpenPanelRequest["threadId"] };
}

function parseBrowserAnnotationEvent(payload: unknown): BrowserAnnotationEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  if (
    !["started", "cancelled", "document-changed", "markers-synced", "committed"].includes(
      String(event.kind),
    ) ||
    typeof event.threadId !== "string" ||
    typeof event.tabId !== "string" ||
    !event.document ||
    typeof event.document !== "object" ||
    !event.source ||
    typeof event.source !== "object"
  ) {
    return null;
  }
  const document = event.document as Record<string, unknown>;
  const source = event.source as Record<string, unknown>;
  if (
    typeof document.token !== "string" ||
    typeof document.key !== "string" ||
    typeof document.url !== "string" ||
    typeof source.url !== "string" ||
    typeof source.pageTitle !== "string"
  ) {
    return null;
  }
  return payload as BrowserAnnotationEvent;
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: getDesktopWsUrl,
  // Absolute path for OS-dropped File objects (folders with spaces/parens, etc.).
  getPathForFile: (file: File) => {
    try {
      const path = webUtils.getPathForFile(file);
      return typeof path === "string" && path.trim().length > 0 ? path : null;
    } catch {
      return null;
    }
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  saveFile: (input) => ipcRenderer.invoke(IPC.saveFile, input),
  confirm: (message) => ipcRenderer.invoke(IPC.confirm, message),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  getAppIcon: () => ipcRenderer.invoke(IPC.getAppIcon),
  setAppIcon: (icon) => ipcRenderer.invoke(IPC.setAppIcon, icon),
  showContextMenu: (items, position) => ipcRenderer.invoke(IPC.contextMenu, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  shell: {
    showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  },
  clipboard: {
    writeImagePngDataUrl: (dataUrl: string) => ipcRenderer.invoke(IPC.clipboardWriteImage, dataUrl),
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IPC.windowState, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.windowState, wrappedListener);
      };
    },
  },
  customTitleBar: {
    getState: () => ipcRenderer.invoke(IPC.customTitleBarGetState),
    setPreference: (enabled) => ipcRenderer.invoke(IPC.customTitleBarSetPreference, enabled),
    relaunch: () => ipcRenderer.invoke(IPC.customTitleBarRelaunch),
  },
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IPC.menuAction, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.menuAction, wrappedListener);
    };
  },
  getZoomFactor: () => {
    const factor = ipcRenderer.sendSync(IPC.zoomFactor);
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  },
  onZoomFactorChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, factor: unknown) => {
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return;
      listener(factor);
    };

    ipcRenderer.on(IPC.zoomFactorChanged, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.zoomFactorChanged, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGetState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IPC.updateState, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.updateState, wrappedListener);
    };
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke(IPC.notificationsIsSupported),
    show: (input) => ipcRenderer.invoke(IPC.notificationsShow, input),
  },
  appSnap: {
    getState: () => ipcRenderer.invoke(IPC.appSnap.getState),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC.appSnap.setEnabled, enabled),
    checkShortcut: (shortcut) => ipcRenderer.invoke(IPC.appSnap.checkShortcut, shortcut),
    setShortcut: (shortcut) => ipcRenderer.invoke(IPC.appSnap.setShortcut, shortcut),
    requestPermissions: () => ipcRenderer.invoke(IPC.appSnap.requestPermissions),
    listPendingCaptures: () => ipcRenderer.invoke(IPC.appSnap.listPendingCaptures),
    acknowledgeCapture: (captureId) =>
      ipcRenderer.invoke(IPC.appSnap.acknowledgeCapture, captureId),
    onCaptured: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, capture: unknown) => {
        if (typeof capture !== "object" || capture === null) return;
        listener(capture as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.appSnap.captured, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appSnap.captured, wrappedListener);
    },
    onError: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, error: unknown) => {
        if (typeof error !== "object" || error === null) return;
        listener(error as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.appSnap.error, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appSnap.error, wrappedListener);
    },
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.appSnap.state, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appSnap.state, wrappedListener);
    },
  },
  storageMigration: {
    readSnapshot: () => ipcRenderer.sendSync(IPC.storageMigration.read),
    acknowledgeSnapshot: () => ipcRenderer.invoke(IPC.storageMigration.acknowledge),
  },
  server: {
    transcribeVoice: (input) => ipcRenderer.invoke(IPC.transcribeVoice, input),
  },
  browser: {
    open: (input) => ipcRenderer.invoke(IPC.browser.open, input),
    close: (input) => ipcRenderer.invoke(IPC.browser.close, input),
    hide: (input) => ipcRenderer.invoke(IPC.browser.hide, input),
    getState: (input) => ipcRenderer.invoke(IPC.browser.getState, input),
    setPanelBounds: async (input) => {
      ipcRenderer.send(IPC.browser.setBounds, input);
    },
    attachWebview: (input) => ipcRenderer.invoke(IPC.browser.attachWebview, input),
    detachWebview: (input) => ipcRenderer.invoke(IPC.browser.detachWebview, input),
    copyLink: (input) => ipcRenderer.invoke(IPC.browser.requestCopyLink, input),
    copyScreenshotToClipboard: (input) =>
      ipcRenderer.invoke(IPC.browser.copyScreenshotToClipboard, input),
    captureScreenshot: (input) => ipcRenderer.invoke(IPC.browser.captureScreenshot, input),
    navigate: (input) => ipcRenderer.invoke(IPC.browser.navigate, input),
    reload: (input) => ipcRenderer.invoke(IPC.browser.reload, input),
    goBack: (input) => ipcRenderer.invoke(IPC.browser.goBack, input),
    goForward: (input) => ipcRenderer.invoke(IPC.browser.goForward, input),
    newTab: (input) => ipcRenderer.invoke(IPC.browser.newTab, input),
    closeTab: (input) => ipcRenderer.invoke(IPC.browser.closeTab, input),
    selectTab: (input) => ipcRenderer.invoke(IPC.browser.selectTab, input),
    openDevTools: (input) => ipcRenderer.invoke(IPC.browser.openDevTools, input),
    annotations: {
      start: (input) => ipcRenderer.invoke(IPC.browser.annotations.start, input),
      cancel: (input) => ipcRenderer.invoke(IPC.browser.annotations.cancel, input),
      syncMarkers: (input) => ipcRenderer.invoke(IPC.browser.annotations.syncMarkers, input),
      onEvent: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
          const annotationEvent = parseBrowserAnnotationEvent(payload);
          if (annotationEvent) listener(annotationEvent);
        };
        ipcRenderer.on(IPC.browser.annotations.event, wrappedListener);
        return () => ipcRenderer.removeListener(IPC.browser.annotations.event, wrappedListener);
      },
    },
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IPC.browser.state, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.state, wrappedListener);
      };
    },
    onBrowserUseOpenPanelRequest: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const request = parseBrowserOpenPanelRequest(payload);
        if (request) {
          listener(request);
        }
      };
      ipcRenderer.on(IPC.browser.requestOpenPanel, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.requestOpenPanel, wrappedListener);
      };
    },
    onBrowserCopyLink: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        listener(payload as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.browser.copyLink, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.copyLink, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);

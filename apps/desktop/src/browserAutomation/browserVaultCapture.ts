import { EventEmitter } from "node:events";
import { installVaultCapture, type CaptureContext, type CapturePage } from "betterwright/capture";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserVault } from "./browserVault";

class NativeCapturePage extends EventEmitter implements CapturePage {
  closed = false;
  lastAgentActivity = 0;
  constructor(readonly runtime: BrowserAutomationVisibleRuntime) {
    super();
  }
  isClosed(): boolean {
    return this.closed || this.runtime.webContents.isDestroyed();
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
}

/** Sensors run only in managed browser pages, never the application renderer. */
export class BrowserVaultCapture {
  private readonly pages = new Set<NativeCapturePage>();
  private readonly pageListeners = new Set<(page: CapturePage) => void>();
  private capture: ReturnType<typeof installVaultCapture> | undefined;
  private updating = Promise.resolve();
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly vault: BrowserVault) {
    this.unsubscribe = vault.onChanged(() => this.refresh());
    this.refresh();
  }

  register(runtime: BrowserAutomationVisibleRuntime): () => void {
    const page = new NativeCapturePage(runtime);
    this.pages.add(page);
    for (const listener of this.pageListeners) listener(page);
    return () => {
      page.close();
      this.pages.delete(page);
    };
  }

  noteAgentActivity(runtime: BrowserAutomationVisibleRuntime): void {
    for (const page of this.pages) {
      if (page.runtime.webContents === runtime.webContents) page.lastAgentActivity = Date.now();
    }
  }

  noteHumanActivity(threadId: string): void {
    for (const page of this.pages) {
      if (page.runtime.threadId === threadId) page.lastAgentActivity = 0;
    }
  }

  private refresh(): void {
    this.updating = this.updating
      .then(async () => {
        const { settings, protection } = await this.vault.snapshot();
        const captureEnabled = settings.offerSave && !protection.locked;
        if (this.disposed || Boolean(this.capture) === captureEnabled) return;
        if (!captureEnabled) {
          await this.capture?.dispose();
          this.capture = undefined;
          return;
        }
        this.capture = installVaultCapture(this.context(), {
          sessionForPage: (page) => page,
          vaultCallAtOrigin: async (session, origin, action, payload) => {
            if (!(session instanceof NativeCapturePage) || session.isClosed())
              throw new Error("Browser page is unavailable.");
            if (action === "list") {
              const snapshot = await this.vault.snapshot();
              return { credentials: snapshot.logins.filter((login) => login.origin === origin) };
            }
            if (action !== "save") throw new Error("Unsupported capture operation.");
            const { username, password, label } = payload;
            if (
              typeof username !== "string" ||
              typeof password !== "string" ||
              typeof label !== "string"
            )
              throw new Error("Invalid captured login.");
            await this.vault.saveCaptured(
              origin,
              { username, password, label, deferToPending: true },
              Date.now() - session.lastAgentActivity < 5000 ? "agent" : "user",
            );
            return {};
          },
          trackSecret: (secret) => this.vault.trackSecret(secret),
          isHeaded: () => true,
          lastModelActivity: () => Number.NaN,
          shouldCapture: (input) => this.vault.shouldOfferSave(input),
          requestSave: ({ origin, username, mode }) =>
            this.vault.askSave({ origin, username, mode: mode === "update" ? "update" : "save" }),
          matchMode: "exact-origin",
          onError: () => this.vault.reportCaptureFailure(),
          onReady: () => this.vault.reportCaptureReady(),
        });
      })
      .catch(() => this.vault.reportCaptureFailure());
  }

  private context(): CaptureContext {
    return {
      pages: () => [...this.pages],
      on: (_event, callback) => {
        this.pageListeners.add(callback);
      },
      off: (_event, callback) => {
        this.pageListeners.delete(callback);
      },
      newCDPSession: async (page) => {
        if (!(page instanceof NativeCapturePage) || page.isClosed())
          throw new Error("Browser page is unavailable.");
        const { webContents } = page.runtime;
        if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
        const info = await webContents.debugger.sendCommand("Target.getTargetInfo");
        const { sessionId } = await webContents.debugger.sendCommand("Target.attachToTarget", {
          targetId: info.targetInfo.targetId,
          flatten: true,
        });
        const events = new EventEmitter();
        const onMessage = (
          _event: unknown,
          method: string,
          parameters: unknown,
          sourceSession?: string,
        ) => {
          if (sourceSession === sessionId) {
            try {
              events.emit(method, parameters);
            } catch {
              this.vault.reportCaptureFailure();
            }
          }
        };
        webContents.debugger.on("message", onMessage);
        return {
          send: (method, parameters) =>
            webContents.debugger.sendCommand(method, parameters, sessionId),
          on: (event, callback) => events.on(event, callback),
          detach: async () => {
            events.removeAllListeners();
            webContents.debugger.removeListener("message", onMessage);
            if (!webContents.isDestroyed())
              await webContents.debugger
                .sendCommand("Target.detachFromTarget", { sessionId })
                .catch(() => {});
          },
        };
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    await this.updating;
    await this.capture?.dispose();
    for (const page of this.pages) page.close();
    this.pages.clear();
    this.pageListeners.clear();
  }
}

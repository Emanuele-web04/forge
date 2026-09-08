import { randomUUID } from "node:crypto";
import { webContents, type WebContents } from "electron";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { betterwrightExpectedInputs } from "./betterwrightInput";
import { BetterwrightKeyboardPolicy } from "./betterwrightKeyboardPolicy";
import { withRendererGuestFocus } from "./betterwrightFocus";

type Params = Record<string, unknown>;
let nativeInputQueue: Promise<unknown> = Promise.resolve();

function enqueueNativeInput(operation: () => Promise<unknown>): Promise<unknown> {
  const pending = nativeInputQueue.then(operation, operation);
  nativeInputQueue = pending.catch(() => {});
  return pending;
}
export interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Params;
  readonly sessionId?: string;
}

const PAGE_DOMAINS = new Set([
  "Accessibility",
  "Animation",
  "CSS",
  "DOM",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "Input",
  "Inspector",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Runtime",
  "Security",
  "WebMCP",
]);
const FORBIDDEN_METHODS = new Set([
  "Page.close",
  "Page.crash",
  "Page.setDownloadBehavior",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Security.setIgnoreCertificateErrors",
  "Security.setOverrideCertificateErrors",
  "Security.handleCertificateError",
]);

function requireWebUrl(value: unknown): void {
  if (value === "about:blank") return;
  if (typeof value !== "string") throw new Error("Missing URL.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Non-web URL denied.");
}

/** A browser-shaped connection whose only authority is one leased WebContents. */
export class BetterwrightCdpTarget {
  private readonly pageSession = randomUUID();
  private readonly browserSessions = new Set<string>();
  private readonly pageSessions = new Set<string>();
  private readonly childSessions = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private endLease!: () => void;
  private readonly leaseEnded = new Promise<void>((resolve) => {
    this.endLease = resolve;
  });
  private readonly keyboardPolicy = new BetterwrightKeyboardPolicy();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private attached = false;

  constructor(
    private readonly contents: WebContents,
    private readonly emit: (message: CdpMessage | Record<string, unknown>) => void,
    private readonly diagnostic?: (
      method: string,
      outcome: "received" | "completed" | "denied",
    ) => void,
    readonly targetId: string = randomUUID(),
    private readonly uploadFiles: ReadonlySet<string> = new Set(),
    private readonly backendSessionId?: string,
    private readonly cookieImport = false,
    private readonly expectAgentInput?: BrowserAutomationVisibleRuntime["expectAgentInput"],
  ) {
    if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    contents.debugger.on("message", this.onMessage);
    contents.debugger.on("detach", this.onDetach);
  }

  private targetInfo() {
    return {
      targetId: this.targetId,
      type: "page",
      title: this.contents.getTitle(),
      url: this.contents.getURL(),
      attached: true,
      browserContextId: this.targetId,
      canAccessOpener: false,
    };
  }

  private readonly onDetach = () => {
    this.disposed = true;
    this.emit({ method: "Target.detachedFromTarget", params: { sessionId: this.pageSession } });
  };

  private readonly onMessage = (
    _event: unknown,
    method: string,
    params: Params,
    sessionId?: string,
  ) => {
    if (this.disposed) return;
    this.diagnostic?.(method, "received");
    if (this.backendSessionId) {
      if (sessionId === this.backendSessionId) sessionId = undefined;
      else if (!sessionId) return;
    }
    if (sessionId && !this.childSessions.has(sessionId)) return;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      this.childSessions.add(params.sessionId);
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.childSessions.delete(params.sessionId);
    }
    if (sessionId) {
      this.emit({ method, params, sessionId });
    } else {
      for (const pageSession of this.pageSessions) {
        this.emit({ method, params, sessionId: pageSession });
      }
    }
  };

  async receive(message: CdpMessage): Promise<void> {
    if (!Number.isSafeInteger(message.id) || typeof message.method !== "string") return;
    const response = {
      id: message.id,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    try {
      this.diagnostic?.(message.method, "received");
      const result = await this.command(message.method, message.params ?? {}, message.sessionId);
      this.diagnostic?.(message.method, "completed");
      if (!this.disposed) this.emit({ ...response, result });
    } catch {
      this.diagnostic?.(message.method, "denied");
      // CDP errors can echo expressions, headers and secrets. Keep the transport error fixed.
      this.emit({
        ...response,
        error: { code: -32000, message: "Browser command unavailable for this target lease." },
      });
    }
  }

  private send(method: string, params: Params, sessionId?: string): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Browser target lease ended."));
    const operation = Promise.race([
      this.contents.debugger.sendCommand(method, params, sessionId ?? this.backendSessionId),
      this.leaseEnded.then(() => {
        throw new Error("Browser target lease ended.");
      }),
    ]);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  private async command(method: string, params: Params, sessionId?: string): Promise<unknown> {
    if (this.disposed || this.contents.isDestroyed())
      throw new Error("Browser target lease ended.");
    const root = !sessionId || this.browserSessions.has(sessionId);
    if (!root && !this.pageSessions.has(sessionId!) && !this.childSessions.has(sessionId!)) {
      throw new Error("Unknown target session.");
    }
    if (method === "Target.getTargetInfo") {
      if (params.targetId !== undefined && params.targetId !== this.targetId)
        throw new Error("Unknown target.");
      return { targetInfo: this.targetInfo() };
    }
    if (root) {
      if (method === "Browser.getVersion") return this.send(method, {});
      if (method === "Target.getTargets") return { targetInfos: [this.targetInfo()] };
      if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.setAutoAttach") {
        if (params.autoAttach && !this.attached) {
          this.attached = true;
          this.pageSessions.add(this.pageSession);
          this.emit({
            method: "Target.attachedToTarget",
            params: {
              sessionId: this.pageSession,
              targetInfo: this.targetInfo(),
              waitingForDebugger: false,
            },
          });
        }
        return {};
      }
      if (method === "Target.attachToBrowserTarget") {
        const id = randomUUID();
        this.browserSessions.add(id);
        return { sessionId: id };
      }
      if (method === "Target.attachToTarget" && params.targetId === this.targetId) {
        const id = randomUUID();
        this.pageSessions.add(id);
        return { sessionId: id };
      }
      if (method === "Target.detachFromTarget") {
        if (typeof params.sessionId !== "string") throw new Error("Missing session.");
        this.browserSessions.delete(params.sessionId);
        this.pageSessions.delete(params.sessionId);
        return {};
      }
      // Cookie reads are bounded to the leased page, never the partition's complete jar.
      if (method === "Storage.getCookies") {
        return this.send("Network.getCookies", { urls: [this.contents.getURL()] });
      }
      throw new Error("Browser-wide command denied.");
    }
    if (method === "Target.setAutoAttach") {
      return this.send(
        method,
        { ...params, flatten: true },
        this.childSessions.has(sessionId!) ? sessionId : undefined,
      );
    }
    if (method === "Network.getCookies") {
      return this.send(
        method,
        { urls: [this.contents.getURL()] },
        this.childSessions.has(sessionId!) ? sessionId : undefined,
      );
    }
    // Only a host-created import worker gets this grant. It never runs model code.
    if (this.cookieImport && ["Network.getAllCookies", "Network.setCookies"].includes(method)) {
      return this.send(method, params, this.childSessions.has(sessionId!) ? sessionId : undefined);
    }
    if (FORBIDDEN_METHODS.has(method) || !PAGE_DOMAINS.has(method.split(".")[0]!)) {
      throw new Error("Command outside target scope.");
    }
    if (method === "DOM.setFileInputFiles") {
      // Only private staged files authorized by the host may cross this lease.
      // An empty list clears a file input without granting filesystem access.
      if (
        !Array.isArray(params.files) ||
        params.files.length > 512 ||
        params.files.some((file) => typeof file !== "string" || !this.uploadFiles.has(file))
      ) {
        throw new Error("Upload not authorized for this target lease.");
      }
    }
    if (method === "Page.navigate" || method === "Network.loadNetworkResource") {
      requireWebUrl(params.url);
    }
    if (method === "Input.dispatchKeyEvent") this.keyboardPolicy.check(params);
    const nativeInput = method.startsWith("Input.") || method === "Page.bringToFront";
    const dispatch = async () => {
      if (this.disposed || this.contents.isDestroyed())
        throw new Error("Browser target lease ended.");
      const releases = betterwrightExpectedInputs(method, params).map((input) =>
        this.expectAgentInput?.(input),
      );
      const previousFocus = nativeInput ? webContents.getFocusedWebContents() : null;
      try {
        // Native focus is shared across tabs; DOM focus alone cannot route text
        // to an offscreen preview. Keep focus and dispatch in the same lease.
        if (nativeInput && previousFocus !== this.contents) this.contents.focus();
        const send = () =>
          this.send(method, params, this.childSessions.has(sessionId!) ? sessionId : undefined);
        if (!nativeInput) return await send();
        const focusedOperation = withRendererGuestFocus(this.contents, send);
        this.pending.add(focusedOperation);
        try {
          return await focusedOperation;
        } finally {
          this.pending.delete(focusedOperation);
        }
      } finally {
        try {
          if (
            previousFocus &&
            previousFocus !== this.contents &&
            !previousFocus.isDestroyed() &&
            webContents.getFocusedWebContents() === this.contents
          )
            previousFocus.focus();
        } finally {
          for (const release of releases) release?.();
        }
      }
    };
    return nativeInput ? enqueueNativeInput(dispatch) : dispatch();
  }

  dispose(cancel = true): Promise<void> {
    this.disposal ??= this.drain(cancel);
    return this.disposal;
  }

  private async drain(cancel: boolean): Promise<void> {
    this.disposed = true;
    this.contents.debugger.removeListener("message", this.onMessage);
    this.contents.debugger.removeListener("detach", this.onDetach);
    let leaseRevoked = this.contents.isDestroyed() || !this.contents.debugger.isAttached();
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) {
      await Promise.allSettled([
        ...(cancel
          ? [
              this.contents.debugger.sendCommand(
                "Runtime.terminateExecution",
                {},
                this.backendSessionId,
              ),
              // An idle renderer applies termination to its next script. Consume
              // that interrupt before releasing the lease, not in the next run.
              this.contents.debugger.sendCommand(
                "Runtime.evaluate",
                { expression: "void 0", silent: true },
                this.backendSessionId,
              ),
              this.contents.debugger.sendCommand("Page.stopLoading", {}, this.backendSessionId),
            ]
          : []),
        this.contents.debugger.sendCommand("Fetch.disable", {}, this.backendSessionId),
      ]);
      if (this.backendSessionId) {
        await this.contents.debugger
          .sendCommand("Target.detachFromTarget", { sessionId: this.backendSessionId })
          .then(
            () => {
              leaseRevoked = true;
            },
            () => {},
          );
      }
    }
    // Electron can leave awaited Runtime replies pending after a child-session
    // detach. Only settle them locally once teardown has acknowledged revocation.
    if (leaseRevoked || this.contents.isDestroyed() || !this.contents.debugger.isAttached())
      this.endLease();
    await Promise.allSettled([...this.pending]);
    // The manager, annotations and diagnostics share this debugger. Never detach or close it here.
  }
}

// FILE: browserSessionPolicy.ts
// Purpose: Owns the persistent Electron browser session identity and popup security policy.
// Layer: Desktop browser infrastructure

import {
  app,
  session,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type Session,
  type WebContents,
} from "electron";
import type { BrowserProfile } from "@synara/contracts";
import {
  buildAcceptLanguageHeader,
  buildChromeClientHints,
  deriveChromeUserAgent,
} from "@synara/shared/browserSession";
import { LEGACY_PERSONAL_BROWSER_PARTITION } from "./browserProfiles";

export const BROWSER_SESSION_PARTITION = LEGACY_PERSONAL_BROWSER_PARTITION;

export interface BrowserSessionDownloadEvent {
  readonly event: Electron.Event;
  readonly item: DownloadItem;
  readonly webContents: WebContents;
}

export type BrowserSessionDownloadListener = (event: BrowserSessionDownloadEvent) => void;

export interface BrowserSessionWebAuthnEvent {
  readonly profile: BrowserProfile;
  readonly details: Electron.SelectWebauthnAccountDetails;
  readonly callback: (credentialId?: string | null) => void;
}

export type BrowserSessionWebAuthnListener = (event: BrowserSessionWebAuthnEvent) => void;

interface ManagedBrowserSession {
  readonly session: Session;
  readonly willDownloadListener:
    | ((event: Electron.Event, item: DownloadItem, webContents: WebContents) => void)
    | null;
  readonly webAuthnListener:
    | ((
        event: Electron.Event,
        details: Electron.SelectWebauthnAccountDetails,
        callback: (credentialId?: string | null) => void,
      ) => void)
    | null;
}

function replaceRequestHeadersCaseInsensitive(
  headers: Record<string, string>,
  replacements: Record<string, string>,
): Record<string, string> {
  const replacementNamesByLower = new Set(
    Object.keys(replacements).map((name) => name.toLowerCase()),
  );
  for (const existing of Object.keys(headers)) {
    if (replacementNamesByLower.has(existing.toLowerCase())) {
      delete headers[existing];
    }
  }
  for (const [name, value] of Object.entries(replacements)) {
    headers[name] = value;
  }
  return headers;
}

export class BrowserSessionPolicy {
  private spoofedUserAgent: string | null = null;
  private readonly configuredSessions = new Map<string, ManagedBrowserSession>();

  constructor(
    private readonly onWillDownload?: BrowserSessionDownloadListener,
    private readonly onWebAuthnAccountSelection?: BrowserSessionWebAuthnListener,
  ) {}

  private resolveUserAgent(): string {
    if (this.spoofedUserAgent === null) {
      this.spoofedUserAgent = deriveChromeUserAgent(app.userAgentFallback, [app.getName()]);
    }
    return this.spoofedUserAgent;
  }

  ensureConfigured(profile: BrowserProfile): Session {
    const existing = this.configuredSessions.get(profile.partition);
    if (existing) {
      return existing.session;
    }

    let partitionSession: Session;
    try {
      partitionSession = session.fromPartition(profile.partition);
    } catch {
      // Electron can briefly reject a partition while the app is still
      // initializing. Retry once without recording a half-configured session.
      partitionSession = session.fromPartition(profile.partition);
    }
    const userAgent = this.resolveUserAgent();
    partitionSession.setUserAgent(userAgent);

    // Browser profiles render untrusted origins. They never inherit permissions
    // granted to Synara's own renderer (for example voice-composer microphone
    // access), and cannot prompt the agent into granting a device capability.
    partitionSession.setPermissionCheckHandler(() => false);
    partitionSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    const clientHints = buildChromeClientHints(userAgent, process.platform);
    const acceptLanguage = buildAcceptLanguageHeader(app.getPreferredSystemLanguages());
    partitionSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = replaceRequestHeadersCaseInsensitive(details.requestHeaders, {
        "User-Agent": userAgent,
        ...(acceptLanguage ? { "Accept-Language": acceptLanguage } : {}),
        ...(clientHints ?? {}),
      });
      callback({ requestHeaders });
    });

    const onWillDownload = this.onWillDownload;
    const willDownloadListener = onWillDownload
      ? (event: Electron.Event, item: DownloadItem, webContents: WebContents) => {
          onWillDownload({ event, item, webContents });
        }
      : null;
    if (willDownloadListener) {
      partitionSession.on("will-download", willDownloadListener);
    }

    const onWebAuthnAccountSelection = this.onWebAuthnAccountSelection;
    const webAuthnListener = onWebAuthnAccountSelection
      ? (
          _event: Electron.Event,
          details: Electron.SelectWebauthnAccountDetails,
          callback: (credentialId?: string | null) => void,
        ) => {
          onWebAuthnAccountSelection({ profile, details, callback });
        }
      : null;
    if (webAuthnListener) {
      partitionSession.on("select-webauthn-account", webAuthnListener);
    }


    this.configuredSessions.set(profile.partition, {
      session: partitionSession,
      willDownloadListener,
      webAuthnListener,
    });
    return partitionSession;
  }
  release(profile: BrowserProfile): void {
    const managed = this.configuredSessions.get(profile.partition);
    if (!managed) return;
    try {
      if (managed.willDownloadListener) {
        managed.session.removeListener("will-download", managed.willDownloadListener);
      }
      if (managed.webAuthnListener) {
        managed.session.removeListener("select-webauthn-account", managed.webAuthnListener);
      }
    } catch {
      // Electron may already be tearing down the profile session.
    }
    this.configuredSessions.delete(profile.partition);
  }

  dispose(): void {
    for (const managed of this.configuredSessions.values()) {
      try {
        if (managed.willDownloadListener) {
          managed.session.removeListener("will-download", managed.willDownloadListener);
        }
        if (managed.webAuthnListener) {
          managed.session.removeListener("select-webauthn-account", managed.webAuthnListener);
        }
      } catch {
        // Electron may already be tearing down sessions during app quit.
      }
    }
    this.configuredSessions.clear();
  }

  applyUserAgent(webContents: Pick<WebContents, "setUserAgent">): void {
    webContents.setUserAgent(this.resolveUserAgent());
  }

  buildOAuthPopupWindowOptions(
    parent: BrowserWindow | null,
    profile: BrowserProfile,
  ): BrowserWindowConstructorOptions {
    return {
      width: 480,
      height: 640,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      title: "Sign in",
      ...(parent ? { parent } : {}),
      webPreferences: {
        partition: profile.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
  }
}

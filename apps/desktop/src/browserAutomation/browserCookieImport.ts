import { BetterWright, listCookieSourceBrowsers, listCookieSourceProfiles, NetworkPolicy } from "betterwright";
import type { BrowserCookieImportInput, BrowserCookieImportResult } from "@synara/contracts";
import type { DesktopBrowserManager } from "../browserManager";
import { openBetterwrightConnection } from "./betterwrightConnection";

const SOURCES = new Set(["chrome", "safari", "edge"]);

export class BrowserCookieImport {
  private busy = false;

  constructor(private readonly home: string, private readonly manager: DesktopBrowserManager, private readonly waitForAgents: () => Promise<void>, private readonly rememberSessionImport: (domains: readonly string[]) => Promise<void> = async () => {}) {}

  async sources() {
    const browsers = (await listCookieSourceBrowsers()).filter(({ id }) => SOURCES.has(id));
    return browsers.map(({ id, name }) => ({ id, name }));
  }

  async profiles(browser: string) {
    if (!SOURCES.has(browser)) throw new Error("Unsupported cookie source.");
    return (await listCookieSourceProfiles(browser)).map(({ id, name }) => ({ id, name }));
  }

  async import(input: BrowserCookieImportInput): Promise<BrowserCookieImportResult> {
    if (this.busy) throw new Error("Another cookie import is running.");
    this.busy = true;
    let releaseHumanOperation: (() => void) | undefined;
    try {
      releaseHumanOperation = this.manager.beginHumanBrowserOperation();
      const runtime = await this.manager.getCookieImportRuntime(input);
      const origin = input.scope === "site" ? new URL(input.origin) : null;
      if (input.scope === "profile" && input.confirmed !== true) throw new Error("Confirm whole-profile session access.");
      if (input.scope === "site" && origin && (!["https:", "http:"].includes(origin.protocol) || origin.origin !== input.origin || new URL(runtime.webContents.getURL()).origin !== input.origin)) {
        throw new Error("Cookie import must match the visible site.");
      }
      const profiles = await this.profiles(input.browser);
      if (!profiles.some(({ id }) => id === input.profile)) throw new Error("Choose an available browser profile.");
      const assertTarget = async () => {
        if ((await this.manager.getCookieImportRuntime(input)).webContents !== runtime.webContents || (origin && new URL(runtime.webContents.getURL()).origin !== origin.origin)) throw new Error("The cookie import destination changed.");
      };
      await assertTarget();
      await this.waitForAgents();
      await assertTarget();
      const connection = await openBetterwrightConnection(runtime.webContents, undefined, [], true);
      let browser: BetterWright | undefined;
      let close: Promise<void> | undefined;
      const stop = () => { close ??= connection.close(false); void close.catch(() => {}); };
      const navigation = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) stop(); };
      runtime.webContents.on("did-start-navigation", navigation);
      runtime.webContents.once("destroyed", stop);
      const timeout = setTimeout(stop, 60_000);
      try {
        await assertTarget();
        browser = new BetterWright({
          home: this.home,
          provider: connection.provider,
          hostOwnedTarget: true,
          downloadPolicy: "deny",
          credentialCapture: false,
          vault: false,
          headless: false,
          adBlock: false,
          parkBackgroundPages: false,
          policy: new NetworkPolicy({ allowLoopback: true }),
        });
        const target = new URL(connection.provider.cdpUrl);
        const result = await browser.syncCookies({
          source: { browser: input.browser, profile: input.profile },
          ...(origin ? { domains: [origin.hostname] } : {}),
          windowsAppBound: "disabled",
          timeoutMs: 30_000,
          cloudConsent: `cdp:${target.host}`,
        });
        if (!result.ok) {
          const stages = ["acquisition", "parse", "decrypt", "decode", "query", "discovery"] as const;
          const stage = stages.find((stage) => stage === result.cookieReaderStage);
          const code = result.cookiePermissionDenied ? "permission_denied" :
            result.cookieReaderCode === "timed_out" ? "timed_out" :
            ["no_selected_source", "no_discovered_source"].includes(result.cookieReaderCode ?? "") ? "source_missing" :
            result.cookieReaderCode === "reader_unavailable" ? "reader_unavailable" :
            result.cookieReaderCode ? "reader_failed" : "transfer_failed";
          return { ok: false, code, platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux", ...(stage ? { stage } : {}) };
        }
        await assertTarget();
        await runtime.webContents.session.cookies.flushStore();
        try {
          if (!Array.isArray(result.cookieImportDomains)) throw new Error("Import scope metadata is unavailable.");
          await this.rememberSessionImport(result.cookieImportDomains);
        }
        catch { return { ok: false, code: "persistence_failed", platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux" }; }
        return { ok: true, imported: result.synced, skipped: result.skipped, warnings: (result.warnings ?? []).map(({ code, count }) => ({ code, count })) };
      } finally {
        clearTimeout(timeout);
        runtime.webContents.removeListener("did-start-navigation", navigation);
        runtime.webContents.removeListener("destroyed", stop);
        stop();
        await close;
        await browser?.close();
      }
    } finally {
      releaseHumanOperation?.();
      this.busy = false;
    }
  }
}

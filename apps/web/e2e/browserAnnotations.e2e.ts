import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserAnnotationEvent, BrowserAnnotationTheme } from "@synara/contracts";
import { _electron as electron, expect, test, type ElectronApplication } from "playwright/test";

import { createBrowserMcpHarness } from "./fixtures/mcpBrowserHarness";
import { startVisibleBrowserFixtureSite } from "./fixtures/siteServer";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(WEB_DIR, "../desktop");
const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));
const DARK_ANNOTATION_THEME: BrowserAnnotationTheme = {
  mode: "dark",
  accent: "rgb(96, 115, 204)",
  surface: "rgb(27, 27, 29)",
  text: "rgb(250, 250, 250)",
  mutedText: "rgb(161, 161, 170)",
  border: "rgb(63, 63, 70)",
  focusBorder: "rgb(96, 115, 204)",
  primary: "rgb(250, 250, 250)",
  primaryText: "rgb(24, 24, 27)",
};

function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  let closeError: unknown;
  const closing = application.close().catch((error: unknown) => {
    closeError = error;
  });
  if (!(await waitForSettlement(closing, 5_000))) {
    application.process().kill("SIGKILL");
    await waitForSettlement(closing, 2_000);
  }
  if (closeError) throw closeError;
}

test("a real Electron guest commits and reprojects a continuous annotation session", async () => {
  const mainPath = process.env.SYNARA_E2E_ELECTRON_MAIN;
  const annotationPreloadPath = process.env.SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD;
  if (!mainPath || !annotationPreloadPath) {
    throw new Error("Electron annotation E2E bundles were not prepared.");
  }

  const site = await startVisibleBrowserFixtureSite();
  const home = mkdtempSync(join(tmpdir(), "synara-browser-annotations-e2e-"));
  const workspaceRoot = join(home, "workspace");
  mkdirSync(workspaceRoot);
  const pipePath = join(home, "browser-host.sock");
  const capability = `browser-annotations-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const threadId = `thread-browser-annotations-${crypto.randomUUID()}`;
  const shellPath = resolve(WEB_DIR, "e2e/fixtures/visibleBrowserShell.html");
  const executablePath = requireFromDesktop("electron") as string;
  const electronApp = await electron.launch({
    executablePath,
    args: [mainPath],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      HOME: home,
      SYNARA_HOME: home,
      SYNARA_BROWSER_HOST_PIPE_PATH: pipePath,
      SYNARA_BROWSER_HOST_CAPABILITY: capability,
      SYNARA_E2E_SHELL_PATH: shellPath,
      SYNARA_E2E_THREAD_ID: threadId,
      SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD: annotationPreloadPath,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await expect(page.locator("html")).toHaveAttribute("data-shell-ready", "true");
    const mcp = createBrowserMcpHarness({
      pipePath,
      capability,
      threadId,
      workspaceRoot,
    });
    await mcp.initialize();
    await expect
      .poll(
        async () => {
          try {
            const status = await mcp.call("browser_status");
            return status.structuredContent.available === true;
          } catch {
            return false;
          }
        },
        { timeout: 5_000, intervals: [25, 50, 100, 200] },
      )
      .toBe(true);
    const annotatedLiveUrl = `${site.appUrl}?token=private-annotation`;
    const opened = await mcp.call("browser_open", {
      url: annotatedLiveUrl,
      show: true,
      reuse: true,
    });
    const tabId = String(opened.structuredContent.tabId);
    await expect(page.locator("webview")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-webview-attached", "true");

    const targetGeometry = await mcp.call("browser_evaluate", {
      expression:
        "(() => { const r = document.querySelector('#manual').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })()",
      idempotencyKey: crypto.randomUUID(),
    });
    const targetRect = targetGeometry.structuredContent.value as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const sensitiveContainerGeometry = await mcp.call("browser_evaluate", {
      expression:
        "(() => { const r = document.querySelector('#private-editor-wrap').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })()",
      idempotencyKey: crypto.randomUUID(),
    });
    const sensitiveContainerRect = sensitiveContainerGeometry.structuredContent.value as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const webviewRect = await page.locator("webview").boundingBox();
    if (!webviewRect) throw new Error("Visible annotation guest lost its bounds.");

    /**
     * Runs a script inside the annotated guest page. MCP browser tools refuse to
     * act while an annotation session holds the webview, so page-side setup and
     * inspection has to go through the runtime the main process already owns.
     */
    const runInGuest = async (script: string): Promise<unknown> =>
      electronApp.evaluate(
        (_electron, input) => {
          const fixture = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  getVisibleAutomationRuntime(value: { threadId: string; tabId: string }): {
                    webContents: { executeJavaScript(script: string): Promise<unknown> };
                  };
                };
              };
            }
          ).__synaraVisibleBrowserE2E;
          return fixture.browserManager
            .getVisibleAutomationRuntime({ threadId: input.threadId, tabId: input.tabId })
            .webContents.executeJavaScript(input.script);
        },
        { threadId, tabId, script },
      );
    /**
     * Calls a method on the main-process browser manager. Rejects when the call
     * throws, so a caller that expects a not-ready failure has to say so.
     */
    const callBrowserManager = async (
      method: "startAnnotation" | "cancelAnnotation" | "syncAnnotationMarkers",
      payload: unknown,
    ): Promise<unknown> =>
      electronApp.evaluate(
        (_electron, input) => {
          const fixture = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: Record<string, (value: unknown) => unknown>;
              };
            }
          ).__synaraVisibleBrowserE2E;
          return fixture.browserManager[input.method]?.(input.payload) ?? null;
        },
        { method, payload },
      );
    /** Every annotation event the host has observed, oldest first. */
    const annotationEvents = async (): Promise<BrowserAnnotationEvent[]> =>
      electronApp.evaluate(() => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { annotationEvents: BrowserAnnotationEvent[] };
          }
        ).__synaraVisibleBrowserE2E;
        return fixture.annotationEvents;
      });
    const annotationEventKinds = async (): Promise<string[]> =>
      (await annotationEvents()).map((event) => event.kind);
    const committedAnnotations = async (): Promise<
      Extract<BrowserAnnotationEvent, { kind: "committed" }>[]
    > =>
      (await annotationEvents()).filter(
        (event): event is Extract<BrowserAnnotationEvent, { kind: "committed" }> =>
          event.kind === "committed",
      );

    await expect
      .poll(
        () =>
          // The guest keeps refusing until its preload has attached, so a throw
          // here is a retry signal rather than a failure.
          callBrowserManager("startAnnotation", {
            threadId,
            tabId,
            theme: DARK_ANNOTATION_THEME,
          }).catch(() => null),
        { timeout: 5_000, intervals: [25, 50, 100, 200] },
      )
      .not.toBeNull();

    // The overlay host is discoverable in the page's DOM, so a hostile page can
    // aim synthetic events at it. None of them may steer the picker: the
    // session hides the native cursor, so a page that could drive the bubble
    // would highlight one element while the real pointer sat on another, and a
    // synthetic Enter would publish a half-typed comment.
    const spoofingReachedOverlayHost = await runInGuest(
      "(() => { const host = document.querySelector('[data-synara-browser-annotations]'); document.dispatchEvent(new PointerEvent('pointermove', { clientX: 3, clientY: 3, bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); host?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return host !== null; })()",
    );
    expect(spoofingReachedOverlayHost).toBe(true);
    const kindsAfterSpoofing = await annotationEventKinds();
    expect(kindsAfterSpoofing).not.toContain("cancelled");
    expect(kindsAfterSpoofing).not.toContain("committed");

    // An element buried too deep to address within the selector bound can never
    // be committed. The picker has to refuse it up front instead of opening a
    // composer whose save would silently turn into a cancel and throw the typed
    // comment away.
    const unanchorableRect = (await runInGuest(
      "(() => { const root = document.createElement('div'); root.setAttribute('data-unanchorable', ''); root.style.cssText = 'position:fixed;left:8px;top:8px;z-index:999;background:rgb(230,230,230)'; let node = root; for (let index = 0; index < 90; index += 1) { const child = document.createElement('div'); node.append(child); node = child; } node.style.cssText = 'padding:14px'; node.textContent = 'deep'; document.body.append(root); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(
      webviewRect.x + unanchorableRect.x + unanchorableRect.width / 2,
      webviewRect.y + unanchorableRect.y + unanchorableRect.height / 2,
    );
    await page.keyboard.type("Never reaches a composer");
    await page.keyboard.press("Enter");
    const kindsAfterUnanchorable = await annotationEventKinds();
    expect(kindsAfterUnanchorable).not.toContain("cancelled");
    expect(kindsAfterUnanchorable).not.toContain("committed");
    await runInGuest(
      "(() => { document.querySelector('[data-unanchorable]')?.remove(); return true; })()",
    );

    await page.mouse.click(
      webviewRect.x + targetRect.x + targetRect.width / 2,
      webviewRect.y + targetRect.y + targetRect.height / 2,
    );
    await page.keyboard.type("Make this action clearer");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(1);

    const committedEvent = (await committedAnnotations())[0];
    expect(committedEvent?.annotation).toMatchObject({
      selector: "#manual",
      name: "Manual Playwright action",
      comment: "Make this action clearer",
      source: { url: site.appUrl },
    });
    expect(JSON.stringify(committedEvent)).not.toContain("private-annotation");

    await page.mouse.click(
      webviewRect.x + sensitiveContainerRect.x + 6,
      webviewRect.y + sensitiveContainerRect.y + sensitiveContainerRect.height / 2,
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(2);
    const sensitiveContainerEvent = (await committedAnnotations())[1];
    expect(sensitiveContainerEvent?.annotation).toMatchObject({
      selector: "#private-editor-wrap",
      name: null,
      text: null,
    });
    expect(JSON.stringify(sensitiveContainerEvent)).not.toContain(
      "Private draft must not be captured",
    );

    // A target can stop being addressable between selection and save. That must
    // not end the session as a cancel: the comment the user already typed has to
    // survive so they can re-pick and save it.
    const staleRect = (await runInGuest(
      "(() => { const root = document.createElement('div'); root.setAttribute('data-stale-chain', ''); root.style.cssText = 'position:fixed;left:8px;top:8px;z-index:999;background:rgb(230,230,230)'; let node = root; for (let index = 0; index < 90; index += 1) { const child = document.createElement('div'); node.append(child); node = child; } node.id = 'stale-leaf'; node.style.cssText = 'padding:14px'; node.textContent = 'stale'; document.body.append(root); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    const clickStaleTarget = async (): Promise<void> => {
      await page.mouse.click(
        webviewRect.x + staleRect.x + staleRect.width / 2,
        webviewRect.y + staleRect.y + staleRect.height / 2,
      );
    };
    await clickStaleTarget();
    await page.keyboard.type("Kept through a stale target");
    // Dropping the id leaves only the structural selector, which this chain is
    // far too deep to fit inside the contract's bound.
    await runInGuest(
      "(() => { document.getElementById('stale-leaf')?.removeAttribute('id'); return true; })()",
    );
    await page.keyboard.press("Enter");
    const kindsAfterStaleSave = await annotationEventKinds();
    expect(kindsAfterStaleSave).not.toContain("cancelled");
    expect(kindsAfterStaleSave.filter((kind) => kind === "committed")).toHaveLength(2);

    await runInGuest(
      "(() => { document.querySelector('[data-stale-chain] div:not(:has(div))').id = 'stale-leaf'; return true; })()",
    );
    await clickStaleTarget();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(3);
    const recoveredEvent = (await committedAnnotations())[2];
    expect(recoveredEvent?.annotation).toMatchObject({
      selector: "#stale-leaf",
      comment: "Kept through a stale target",
    });
    await runInGuest(
      "(() => { document.querySelector('[data-stale-chain]')?.remove(); return true; })()",
    );

    // If a selected element collapses without disconnecting, the hidden
    // composer must release it without allowing Enter to publish an invisible
    // annotation. The typed comment still carries into the next valid pick.
    const collapsingRect = (await runInGuest(
      "(() => { const target = document.createElement('button'); target.id = 'collapsing-target'; target.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:999;padding:14px'; target.textContent = 'collapse'; document.body.append(target); const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    const clickCollapsingTarget = async (): Promise<void> => {
      await page.mouse.click(
        webviewRect.x + collapsingRect.x + collapsingRect.width / 2,
        webviewRect.y + collapsingRect.y + collapsingRect.height / 2,
      );
    };
    await clickCollapsingTarget();
    await page.keyboard.type("Kept through a collapsed target");
    await runInGuest(
      "(() => { document.getElementById('collapsing-target').style.display = 'none'; return true; })()",
    );
    // Submit immediately, before relying on the next overlay animation frame
    // to notice the collapsed box.
    await page.keyboard.press("Enter");
    expect(await committedAnnotations()).toHaveLength(3);
    await runInGuest(
      "(() => { document.getElementById('collapsing-target').style.display = 'block'; return true; })()",
    );
    await clickCollapsingTarget();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(4);
    expect((await committedAnnotations())[3]?.annotation.comment).toBe(
      "Kept through a collapsed target",
    );
    await runInGuest(
      "(() => { document.getElementById('collapsing-target')?.remove(); return true; })()",
    );

    // A long unique ancestor id can make its anchored selector exceed the
    // contract even though the ordinary structural path remains short. Keep
    // walking in that case, and preserve the existing Cmd/Ctrl+Enter shortcut.
    const fallbackSelectorRect = (await runInGuest(
      "(() => { const root = document.createElement('div'); root.id = `anchor-${'x'.repeat(490)}`; root.setAttribute('data-long-anchor', ''); root.style.cssText = 'position:fixed;right:8px;top:8px;z-index:999;background:rgb(230,230,230)'; const target = document.createElement('button'); target.style.cssText = 'padding:14px'; target.textContent = 'fallback'; root.append(target); document.body.append(root); const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(
      webviewRect.x + fallbackSelectorRect.x + fallbackSelectorRect.width / 2,
      webviewRect.y + fallbackSelectorRect.y + fallbackSelectorRect.height / 2,
    );
    await page.keyboard.type("Fallback selector and shortcut");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(5);
    const fallbackSelectorEvent = (await committedAnnotations())[4];
    expect(fallbackSelectorEvent?.annotation.comment).toBe("Fallback selector and shortcut");
    expect(fallbackSelectorEvent?.annotation.selector).not.toContain("anchor-");
    await runInGuest(
      "(() => { document.querySelector('[data-long-anchor]')?.remove(); return true; })()",
    );

    const manualClicks = await runInGuest("document.body.dataset.manualClicks");
    expect(manualClicks).toBe("0");
    const hostileCapture = await runInGuest(
      "({ capture: globalThis.__annotationHostileCapture, unexpectedKeyups: globalThis.__annotationUnexpectedKeyups })",
    );
    expect(hostileCapture).toEqual({ capture: [], unexpectedKeyups: [] });

    if (!committedEvent) throw new Error("Annotation commit event was not captured.");
    await callBrowserManager("cancelAnnotation", { threadId, tabId });
    const awayFromAnnotation = await mcp.call("browser_navigate", {
      tabId,
      url: site.nextUrl,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(awayFromAnnotation.structuredContent.finalUrl).toBe(site.nextUrl);
    const returnedToAnnotation = await mcp.call("browser_navigate", {
      tabId,
      annotationId: committedEvent.annotation.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(returnedToAnnotation.structuredContent.finalUrl).toBe(annotatedLiveUrl);

    await callBrowserManager("syncAnnotationMarkers", {
      threadId,
      tabId,
      version: 1,
      markers: [
        {
          id: committedEvent.annotation.id,
          ordinal: 1,
          documentKey: committedEvent.document.key,
          source: committedEvent.annotation.source,
          selector: committedEvent.annotation.selector,
          fingerprint: committedEvent.annotation.fingerprint,
        },
      ],
    });
    await expect
      .poll(
        async () =>
          (await annotationEvents()).some(
            (event) =>
              event.kind === "markers-synced" &&
              event.projectedMarkerIds.includes(committedEvent.annotation.id),
          ),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);

    await callBrowserManager("startAnnotation", {
      threadId,
      tabId,
      theme: DARK_ANNOTATION_THEME,
    });
    const markerSyncCountBeforeHash = (await annotationEvents()).filter(
      (event) => event.kind === "markers-synced",
    ).length;
    await runInGuest(
      "history.pushState({}, '', location.pathname + location.search + '#annotation-cancelled')",
    );
    await expect
      .poll(
        async () =>
          (await annotationEvents()).some(
            (event) => event.kind === "cancelled" && event.reason === "navigation",
          ),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const markerSyncs = (await annotationEvents()).filter(
            (event): event is Extract<BrowserAnnotationEvent, { kind: "markers-synced" }> =>
              event.kind === "markers-synced",
          );
          const latest = markerSyncs.at(-1);
          return (
            markerSyncs.length > markerSyncCountBeforeHash &&
            latest?.projectedMarkerIds.includes(committedEvent.annotation.id) === true
          );
        },
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    await page.mouse.click(
      webviewRect.x + targetRect.x + targetRect.width / 2,
      webviewRect.y + targetRect.y + targetRect.height / 2,
    );
    await expect
      .poll(() => runInGuest("document.body.dataset.manualClicks"), {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe("1");
  } finally {
    await closeElectronApplication(electronApp);
    await site.close();
    rmSync(home, { recursive: true, force: true });
  }
});

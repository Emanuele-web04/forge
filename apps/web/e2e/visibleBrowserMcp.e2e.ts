import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSER_TOOL_NAMES } from "@synara/contracts";
import { _electron as electron, expect, test, type ElectronApplication } from "playwright/test";

import { createBrowserMcpHarness } from "./fixtures/mcpBrowserHarness";
import { startVisibleBrowserFixtureSite } from "./fixtures/siteServer";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps/desktop");
const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));

function key(): string {
  return crypto.randomUUID();
}

function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  let closeError: unknown;
  const closing = application.close().catch((error: unknown) => {
    closeError = error;
  });
  if (!(await waitForSettlement(closing, 5_000))) {
    // A failed browser command must not obscure its own assertion by leaving a
    // wedged Electron process in Playwright teardown forever.
    application.process().kill("SIGKILL");
    await waitForSettlement(closing, 2_000);
  }
  if (closeError) throw closeError;
}

function targetByName(
  snapshot: Record<string, unknown>,
  name: string,
): { readonly ref: string; readonly snapshotId: string } {
  const elements = snapshot.elements;
  if (!Array.isArray(elements)) throw new Error("Snapshot omitted semantic elements.");
  const element = elements.find(
    (candidate) =>
      candidate && typeof candidate === "object" && (candidate as { name?: unknown }).name === name,
  ) as { ref?: unknown } | undefined;
  if (typeof element?.ref !== "string" || typeof snapshot.snapshotId !== "string") {
    throw new Error(`Snapshot did not contain ${name}.`);
  }
  return { ref: element.ref, snapshotId: snapshot.snapshotId };
}

test("production MCP controls one persistent Electron page across visibility changes", async () => {
  const mainPath = process.env.SYNARA_E2E_ELECTRON_MAIN;
  if (!mainPath) throw new Error("Electron E2E main bundle was not prepared.");
  const site = await startVisibleBrowserFixtureSite();
  const home = mkdtempSync(join(tmpdir(), "synara-visible-browser-e2e-"));
  const workspaceRoot = join(home, "workspace");
  mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, "fixture-upload.txt"), "visible-browser-upload\n", "utf8");
  writeFileSync(join(home, "outside-workspace.txt"), "must-not-upload\n", "utf8");
  symlinkSync(join(home, "outside-workspace.txt"), join(workspaceRoot, "outside-link.txt"));
  const pipePath = join(home, "browser-host.sock");
  const capability = `visible-browser-e2e-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const threadId = `thread-visible-browser-${crypto.randomUUID()}`;
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
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await expect(page.locator("html")).toHaveAttribute("data-shell-ready", "true");
    const runtimeDetails = (scopedTabId: string) =>
      electronApp.evaluate(
        (_electron, input) => {
          const state = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  runtimes: Map<string, { webContents: { id: number; getURL(): string } }>;
                };
              };
            }
          ).__synaraVisibleBrowserE2E;
          const runtime = state.browserManager.runtimes.get(`${input.threadId}:${input.tabId}`);
          if (!runtime) throw new Error("Expected the native browser runtime to be live.");
          return { id: runtime.webContents.id, url: runtime.webContents.getURL() };
        },
        { threadId, tabId: scopedTabId },
      );
    const sendNativeInput = (scopedTabId: string, event: Record<string, unknown>) =>
      electronApp.evaluate(
        (_electron, input) => {
          const state = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  runtimes: Map<
                    string,
                    { webContents: { sendInputEvent(event: Record<string, unknown>): void } }
                  >;
                };
              };
            }
          ).__synaraVisibleBrowserE2E;
          const runtime = state.browserManager.runtimes.get(`${input.threadId}:${input.tabId}`);
          if (!runtime) throw new Error("Expected the native browser runtime to be live.");
          runtime.webContents.sendInputEvent(input.event);
        },
        { threadId, tabId: scopedTabId, event },
      );

    const mcp = createBrowserMcpHarness({
      pipePath,
      capability,
      threadId,
      workspaceRoot,
    });
    const initialized = await mcp.initialize();
    expect(initialized.protocolVersion).toBe("2025-06-18");
    const tools = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOL_NAMES);

    const beforeStatus = await mcp.call("browser_status");
    expect(beforeStatus.structuredContent).toMatchObject({
      available: true,
      physicalScope: "visible-shared-electron-webview",
      authorization: "not-required",
    });

    const opened = await mcp.call("browser_open", {
      url: site.initialUrl,
      show: true,
      reuse: true,
    });
    const tabId = opened.structuredContent.tabId;
    expect(typeof tabId).toBe("string");
    await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", String(tabId));
    const initialRuntime = await runtimeDetails(String(tabId));
    expect(initialRuntime.url).toBe(site.initialUrl);

    await electronApp.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
        }
      ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(false);
    });
    await mcp.call("browser_evaluate", {
      expression: `document.body.dataset.backgroundAgent = "continued"; true`,
      idempotencyKey: key(),
    });
    const backgroundProbe = await mcp.call("browser_evaluate", {
      expression: `document.body.dataset.backgroundAgent`,
      idempotencyKey: key(),
    });
    expect(backgroundProbe.structuredContent.value).toBe("continued");
    expect((await runtimeDetails(String(tabId))).id).toBe(initialRuntime.id);
    await electronApp.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
        }
      ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(true);
    });

    const navigated = await mcp.call("browser_navigate", {
      url: site.appUrl,
      waitUntil: "domcontentloaded",
    });
    expect(navigated.structuredContent).toMatchObject({ tabId, finalUrl: site.appUrl });
    expect((await runtimeDetails(String(tabId))).url).toBe(site.appUrl);

    // A real provider may use evaluate for a client-side navigation. Prove the
    // CDP target and the native view remain the same physical page,
    // rather than allowing metadata to advance on a hidden runtime.
    await mcp.call("browser_evaluate", {
      expression: `location.href = ${JSON.stringify(site.nextUrl)}; true`,
      idempotencyKey: key(),
    });
    await mcp.call("browser_wait", {
      conditions: [{ kind: "url", exact: site.nextUrl }],
    });
    expect((await runtimeDetails(String(tabId))).url).toBe(site.nextUrl);
    expect((await runtimeDetails(String(tabId))).id).toBe(initialRuntime.id);
    await mcp.call("browser_navigate", {
      tabId,
      url: site.appUrl,
      waitUntil: "domcontentloaded",
      idempotencyKey: key(),
    });

    const resized = await mcp.call("browser_resize", {
      width: 760,
      height: 520,
      idempotencyKey: key(),
    });
    expect(resized.structuredContent).toMatchObject({
      tabId,
      requested: { width: 760, height: 520 },
      observed: { height: 520 },
    });
    // The fixture page has a vertical scrollbar, so Chromium reports the CSS
    // layout viewport minus its scrollbar while retaining the requested outer
    // device-metrics width.
    expect((resized.structuredContent.observed as { width: number }).width).toBeGreaterThanOrEqual(
      740,
    );
    expect((resized.structuredContent.observed as { width: number }).width).toBeLessThanOrEqual(
      760,
    );
    await mcp.call("browser_wait", {
      conditions: [{ kind: "text", text: "Delayed fixture ready", state: "present" }],
    });

    const defaultSnapshot = await mcp.call("browser_snapshot");
    expect(defaultSnapshot.structuredContent).not.toHaveProperty("image");
    expect(defaultSnapshot.content.some((item) => item.type === "image")).toBe(false);

    let snapshotResult = await mcp.call("browser_snapshot", {
      includeImage: true,
      includeDiagnostics: true,
    });
    expect(snapshotResult.structuredContent).toMatchObject({
      tabId,
      url: site.appUrl,
      semanticSource: "bounded-wai-aria",
      truncationReasons: [],
      image: { mimeType: "image/png" },
    });
    const png = snapshotResult.content.find((item) => item.type === "image");
    expect(png?.mimeType).toBe("image/png");
    const pngBytes = Buffer.from(String(png?.data), "base64");
    expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const viewportScreenshot = await mcp.call("browser_screenshot");
    expect(viewportScreenshot.structuredContent).toMatchObject({
      tabId,
      url: site.appUrl,
      mode: "viewport",
      clipped: false,
      image: { mimeType: "image/png" },
    });
    const viewportPng = viewportScreenshot.content.find((item) => item.type === "image");
    expect(Buffer.from(String(viewportPng?.data), "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const fullPageScreenshot = await mcp.call("browser_screenshot", { fullPage: true });
    expect(fullPageScreenshot.structuredContent).toMatchObject({
      tabId,
      url: site.appUrl,
      mode: "fullPage",
      clipped: false,
      image: { mimeType: "image/png" },
    });
    expect(
      (fullPageScreenshot.structuredContent.image as { height: number }).height,
    ).toBeGreaterThan(2_000);

    const hoverTarget = targetByName(snapshotResult.structuredContent, "Reveal hover state");
    await mcp.call("browser_hover", {
      target: hoverTarget,
      idempotencyKey: key(),
    });
    const hoverState = await mcp.call("browser_evaluate", {
      expression: `(() => { const node = document.querySelector('#hover-result'); return { visibility: getComputedStyle(node).visibility, trusted: node.dataset.trusted }; })()`,
      idempotencyKey: key(),
    });
    expect(hoverState.structuredContent.value).toEqual({
      visibility: "visible",
      trusted: "true",
    });

    snapshotResult = await mcp.call("browser_snapshot");
    await mcp.call("browser_select", {
      target: targetByName(snapshotResult.structuredContent, "Fixture choice"),
      values: ["beta"],
      idempotencyKey: key(),
    });
    await mcp.call("browser_wait", {
      conditions: [{ kind: "text", text: "Selected: beta", state: "present" }],
    });

    snapshotResult = await mcp.call("browser_snapshot");
    const uploadTarget = targetByName(snapshotResult.structuredContent, "Fixture upload");
    const uploaded = await mcp.call("browser_upload", {
      target: uploadTarget,
      paths: ["fixture-upload.txt"],
      idempotencyKey: key(),
    });
    expect(uploaded.structuredContent.files).toEqual([
      { name: "fixture-upload.txt", byteLength: 23 },
    ]);
    await mcp.call("browser_wait", {
      conditions: [{ kind: "text", text: "Uploaded: fixture-upload.txt:23", state: "present" }],
    });
    await expect(
      mcp.call("browser_upload", {
        target: uploadTarget,
        paths: ["outside-link.txt"],
        timeoutMs: 1_000,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/BrowserUploadPathOutsideWorkspace/);

    snapshotResult = await mcp.call("browser_snapshot");
    try {
      await mcp.call("browser_drag", {
        source: targetByName(snapshotResult.structuredContent, "Drag source"),
        target: targetByName(snapshotResult.structuredContent, "Drop target"),
        steps: 8,
        timeoutMs: 2_000,
        idempotencyKey: key(),
      });
    } catch (error) {
      const dragDiagnostics = await mcp.call("browser_evaluate", {
        expression: `({
          source: document.querySelector('#drag-source').getBoundingClientRect().toJSON(),
          target: document.querySelector('#drop-target').getBoundingClientRect().toJSON(),
          dragMousedown: document.body.dataset.dragMousedown,
          dragMousemove: document.body.dataset.dragMousemove,
          dragstart: document.body.dataset.dragstart,
          dragend: document.body.dataset.dragend,
          drop: document.body.dataset.drop
        })`,
        idempotencyKey: key(),
      });
      throw new Error(
        `browser_drag failed with ${String(error)}; diagnostics=${JSON.stringify(dragDiagnostics.structuredContent.value)}`,
      );
    }
    await mcp.call("browser_wait", {
      conditions: [{ kind: "text", text: "Dragged: yes", state: "present" }],
    });

    for (const expectedDialog of [
      {
        name: "Open alert dialog",
        kind: "alert",
        action: "accepted",
        result: "Dialog result: alert-continued",
      },
      {
        name: "Open confirm dialog",
        kind: "confirm",
        action: "dismissed",
        result: "Dialog result: confirm-false",
      },
      {
        name: "Open prompt dialog",
        kind: "prompt",
        action: "dismissed",
        result: "Dialog result: prompt-null",
      },
    ] as const) {
      snapshotResult = await mcp.call("browser_snapshot");
      const clickedDialog = await mcp.call("browser_click", {
        target: targetByName(snapshotResult.structuredContent, expectedDialog.name),
        idempotencyKey: key(),
      });
      expect(clickedDialog.structuredContent.dialogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: expectedDialog.kind,
            action: expectedDialog.action,
          }),
        ]),
      );
      await mcp.call("browser_wait", {
        conditions: [{ kind: "text", text: expectedDialog.result, state: "present" }],
      });
    }

    snapshotResult = await mcp.call("browser_snapshot");
    await mcp.call("browser_click", {
      target: targetByName(snapshotResult.structuredContent, "Emit fixture logs"),
      idempotencyKey: key(),
    });
    await mcp.call("browser_wait", {
      conditions: [
        {
          kind: "target",
          target: { selector: "body[data-logs-emitted='true']" },
          state: "attached",
        },
      ],
    });
    const logs = await mcp.call("browser_logs", { limit: 200 });
    const logJson = JSON.stringify(logs.structuredContent);
    expect(logJson).toContain("Fixture console warning");
    expect(logJson).toContain("/api/fixture");
    expect(logJson).not.toContain("SECRET_HEADER_MUST_NOT_LEAK");
    expect(logJson).not.toContain("SECRET_BODY_MUST_NOT_LEAK");

    snapshotResult = await mcp.call("browser_snapshot");
    await expect(
      mcp.call("browser_click", {
        target: targetByName(snapshotResult.structuredContent, "Download fixture"),
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/BrowserDownloadApprovalRequired/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(home, "Downloads", "fixture-download.txt"))).toBe(false);

    snapshotResult = await mcp.call("browser_snapshot");
    const oauthWindowPromise = electronApp.waitForEvent("window");
    const oauthPopupClick = await mcp.call("browser_click", {
      target: targetByName(snapshotResult.structuredContent, "Open OAuth popup"),
      idempotencyKey: key(),
    });
    expect(oauthPopupClick.structuredContent).toMatchObject({
      tabId,
      humanActionRequired: {
        kind: "oauth_popup",
        instruction: "Complete sign-in in the visible popup before continuing.",
      },
    });
    const oauthWindow = await oauthWindowPromise;
    await expect(
      oauthWindow.getByRole("heading", { name: "Complete fixture sign-in" }),
    ).toBeVisible();
    const afterOAuthTabs = await mcp.call("browser_tabs");
    expect(afterOAuthTabs.structuredContent).toMatchObject({
      activeTabId: tabId,
      assignedTabId: tabId,
    });
    expect(afterOAuthTabs.structuredContent.tabs).toHaveLength(1);
    await oauthWindow.close();

    snapshotResult = await mcp.call("browser_snapshot");
    const popupClick = await mcp.call("browser_click", {
      target: targetByName(snapshotResult.structuredContent, "Open fixture tab"),
      idempotencyKey: key(),
    });
    if (typeof popupClick.structuredContent.openedTabId !== "string") {
      const unresolvedPopupTabs = await mcp.call("browser_tabs");
      const unresolvedPopupLink = await mcp.call("browser_evaluate", {
        expression: `(() => { const link = document.querySelector('#new-tab'); return { href: link?.href, target: link?.target, activeElement: document.activeElement?.id }; })()`,
        idempotencyKey: key(),
      });
      throw new Error(
        `target=_blank click did not report openedTabId; click=${JSON.stringify(popupClick.structuredContent)}; tabs=${JSON.stringify(unresolvedPopupTabs.structuredContent)}; link=${JSON.stringify(unresolvedPopupLink.structuredContent.value)}`,
      );
    }
    const popupTabId = String(popupClick.structuredContent.openedTabId);
    const popupTabs = await mcp.call("browser_tabs");
    expect(popupTabs.structuredContent).toMatchObject({
      activeTabId: popupTabId,
      assignedTabId: popupTabId,
    });
    expect(popupTabs.structuredContent.tabs).toHaveLength(2);
    const popupSnapshot = await mcp.call("browser_snapshot");
    expect(popupSnapshot.structuredContent).toMatchObject({
      tabId: popupTabId,
      title: "Popup fixture",
    });
    expect(popupSnapshot.structuredContent.visibleText).toContain("Agent-created fixture tab");
    const popupClosed = await mcp.call("browser_close", {
      tabId: popupTabId,
      idempotencyKey: key(),
    });
    expect(popupClosed.structuredContent).toMatchObject({
      closedTabId: popupTabId,
      activeTabId: tabId,
    });
    await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", String(tabId));

    await mcp.call("browser_navigate", {
      tabId,
      url: site.nextUrl,
      waitUntil: "load",
      idempotencyKey: key(),
    });
    const wentBack = await mcp.call("browser_back", {
      tabId,
      waitUntil: "domcontentloaded",
      idempotencyKey: key(),
    });
    expect(wentBack.structuredContent.finalUrl).toBe(site.appUrl);
    const wentForward = await mcp.call("browser_forward", {
      tabId,
      waitUntil: "load",
      idempotencyKey: key(),
    });
    expect(wentForward.structuredContent.finalUrl).toBe(site.nextUrl);
    const reloaded = await mcp.call("browser_reload", {
      tabId,
      waitUntil: "networkidle",
      ignoreCache: true,
      idempotencyKey: key(),
    });
    expect(reloaded.structuredContent.finalUrl).toBe(site.nextUrl);
    const redirected = await mcp.call("browser_navigate", {
      tabId,
      url: site.redirectUrl,
      waitUntil: "load",
      idempotencyKey: key(),
    });
    expect(redirected.structuredContent.finalUrl).toBe(site.nextUrl);
    expect(redirected.structuredContent.redirects).toContain(site.redirectUrl);
    await expect(
      mcp.call("browser_navigate", {
        tabId,
        url: "file:///etc/passwd",
        timeoutMs: 1_000,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/BrowserNavigationBlocked/);
    await mcp.call("browser_navigate", {
      tabId,
      url: site.appUrl,
      waitUntil: "domcontentloaded",
      idempotencyKey: key(),
    });

    snapshotResult = await mcp.call("browser_snapshot");
    await expect(
      mcp.call("browser_click", {
        target: targetByName(snapshotResult.structuredContent, "Disabled action"),
        timeoutMs: 500,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/BrowserTargetNotEnabled/);
    await expect(
      mcp.call("browser_click", {
        target: targetByName(snapshotResult.structuredContent, "Covered action"),
        timeoutMs: 500,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/BrowserTargetObscured/);

    const stableAgentTarget = targetByName(snapshotResult.structuredContent, "Commit agent action");
    await mcp.call("browser_evaluate", {
      expression:
        "document.querySelector('#state').setAttribute('data-unrelated-mutation', String(Date.now())); true",
      idempotencyKey: key(),
    });
    await mcp.call("browser_click", {
      ...stableAgentTarget,
      idempotencyKey: key(),
    });
    const pointGeometry = await mcp.call("browser_evaluate", {
      expression: `(() => { const r = document.querySelector('#point').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      idempotencyKey: key(),
    });
    await mcp.call("browser_click", {
      target: { point: pointGeometry.structuredContent.value },
      idempotencyKey: key(),
    });
    await mcp.call("browser_wait", {
      conditions: [{ kind: "text", text: "Point clicks: 1", state: "present" }],
    });
    await mcp.call("browser_evaluate", {
      expression: String.raw`(() => {
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < 300; index += 1) {
          const button = document.createElement("button");
          button.textContent = "Offscreen action " + index;
          button.style.position = "absolute";
          button.style.top = (1000 + index * 36) + "px";
          fragment.append(button);
        }
        document.body.append(fragment);
        return true;
      })()`,
      idempotencyKey: key(),
    });
    const compactSnapshot = await mcp.call("browser_snapshot", { includeImage: false });
    expect(Array.isArray(compactSnapshot.structuredContent.elements)).toBe(true);
    expect((compactSnapshot.structuredContent.elements as unknown[]).length).toBe(120);
    expect(compactSnapshot.structuredContent.truncationReasons).toContain("semantic-element-limit");
    expect(() => targetByName(compactSnapshot.structuredContent, "Shared input")).not.toThrow();
    expect(
      Buffer.byteLength(JSON.stringify(compactSnapshot.structuredContent), "utf8"),
    ).toBeLessThan(36_000);
    const compactText = compactSnapshot.content.find((item) => item.type === "text")?.text;
    expect(Buffer.byteLength(String(compactText ?? ""), "utf8")).toBeLessThan(16_000);

    snapshotResult = await mcp.call("browser_snapshot", { includeImage: false });
    const hostComposer = page.getByLabel("Host composer");
    await hostComposer.fill("HOST_SENTINEL");
    await hostComposer.focus();
    const sharedInputByElementId = targetByName(snapshotResult.structuredContent, "Shared input");
    await mcp.call("browser_type", {
      elementId: sharedInputByElementId.ref,
      snapshotId: sharedInputByElementId.snapshotId,
      text: "shared-through-mcp",
      idempotencyKey: key(),
    });
    await expect(hostComposer).toHaveValue("HOST_SENTINEL");
    await mcp.call("browser_press", {
      keys: ["ctrl+a", "BACKSPACE", "x", "y", "ArrowLeft", "Delete"],
      idempotencyKey: key(),
    });
    const edited = await mcp.call("browser_evaluate", {
      expression: "document.querySelector('input').value",
      idempotencyKey: key(),
    });
    expect(edited.structuredContent.value).toBe("x");
    snapshotResult = await mcp.call("browser_snapshot", { includeImage: false });
    const sharedInputByBareRef = targetByName(snapshotResult.structuredContent, "Shared input");
    await expect(
      mcp.call("browser_type", {
        ref: sharedInputByBareRef.ref,
        text: "shared-through-mcp",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/BrowserInputUnsupported/);
    await mcp.call("browser_type", {
      ref: sharedInputByBareRef.ref,
      snapshotId: sharedInputByBareRef.snapshotId,
      text: "shared-through-mcp",
      idempotencyKey: key(),
    });
    await mcp.call("browser_press", {
      key: "ENTER",
      idempotencyKey: key(),
    });
    await mcp.call("browser_wait", { timeMs: 25 });
    await mcp.call("browser_wait", { timeoutMs: 100 });
    await expect(hostComposer).toHaveValue("HOST_SENTINEL");
    await expect(page.locator("html")).toHaveAttribute("data-host-submits", "0");
    const scrolled = await mcp.call("browser_scroll", {
      direction: "end",
      amount: 1_000,
      idempotencyKey: key(),
    });
    expect((scrolled.structuredContent.after as { y: number }).y).toBeGreaterThan(0);
    await mcp.call("browser_wait", {
      mode: "all",
      conditions: [{ kind: "text", text: "Agent clicks: 1", state: "present" }],
    });

    // Return to the top through Electron's native input path. Playwright's
    // renderer-scoped mouse cannot target a sibling WebContentsView.
    await sendNativeInput(String(tabId), { type: "mouseMove", x: 30, y: 30 });
    for (let step = 0; step < 32; step += 1) {
      await sendNativeInput(String(tabId), {
        type: "mouseWheel",
        x: 30,
        y: 30,
        deltaY: 1_000,
        canScroll: true,
      });
    }
    // Electron acknowledges input before Chromium applies guest scrolling.
    // Observe convergence through the public browser tool.
    await expect
      .poll(
        async () => {
          const probe = await mcp.call("browser_evaluate", {
            expression: "scrollY",
            idempotencyKey: key(),
          });
          return probe.structuredContent.value;
        },
        { timeout: 2_000, intervals: [25, 50, 100] },
      )
      .toBe(0);
    const manualGeometry = await mcp.call("browser_evaluate", {
      expression: `(() => { const r = document.querySelector('#manual').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scrollY }; })()`,
      idempotencyKey: key(),
    });
    const rect = manualGeometry.structuredContent.value as {
      x: number;
      y: number;
      width: number;
      height: number;
      scrollY: number;
    };
    expect(rect.scrollY).toBe(0);
    const interruptedByManualClick = mcp
      .call("browser_wait", {
        conditions: [{ kind: "text", text: "This text never appears", state: "present" }],
        timeoutMs: 5_000,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // Let the request enter its polling loop so this is a real concurrent human
    // takeover, not an already-aborted request that never reached the page.
    await new Promise((resolve) => setTimeout(resolve, 75));
    const manualX = Math.round(rect.x + rect.width / 2);
    const manualY = Math.round(rect.y + rect.height / 2);
    await sendNativeInput(String(tabId), { type: "mouseMove", x: manualX, y: manualY });
    await sendNativeInput(String(tabId), {
      type: "mouseDown",
      x: manualX,
      y: manualY,
      button: "left",
      clickCount: 1,
    });
    await sendNativeInput(String(tabId), {
      type: "mouseUp",
      x: manualX,
      y: manualY,
      button: "left",
      clickCount: 1,
    });
    const interruptionError = await interruptedByManualClick;
    expect(interruptionError).toBeInstanceOf(Error);
    expect((interruptionError as Error).message).toMatch(/BrowserInterruptedByHuman/);

    await mcp.call("browser_wait", {
      conditions: [{ kind: "text", text: "Manual clicks: 1", state: "present" }],
    });
    const sharedState = await mcp.call("browser_evaluate", {
      expression: `({ value: document.querySelector('input').value, agentClicks: document.body.dataset.agentClicks, pointClicks: document.body.dataset.pointClicks, manualClicks: document.body.dataset.manualClicks, presses: document.body.dataset.presses, cookie: document.cookie })`,
      idempotencyKey: key(),
    });
    expect(sharedState.structuredContent.value).toEqual({
      value: "shared-through-mcp",
      agentClicks: "1",
      pointClicks: "1",
      manualClicks: "1",
      presses: "1",
      cookie: expect.stringContaining("shared_cookie=agent"),
    });
    expect(String((sharedState.structuredContent.value as { cookie: string }).cookie)).toContain(
      "manual_cookie=playwright",
    );

    // Exercise the actual MCP cancellation path used by provider interruption,
    // then prove the per-tab queue drained and remains usable immediately.
    await mcp.cancelCall("browser_wait", {
      conditions: [{ kind: "text", text: "Cancellation sentinel never appears", state: "present" }],
      timeoutMs: 10_000,
    });
    const afterCancellation = await mcp.call("browser_evaluate", {
      expression: "document.title",
      idempotencyKey: key(),
    });
    expect(afterCancellation.structuredContent.value).toBe("Visible browser fixture");

    const tabs = await mcp.call("browser_tabs");
    expect(tabs.structuredContent).toMatchObject({ activeTabId: tabId, assignedTabId: tabId });
    expect(tabs.structuredContent.tabs).toEqual([
      expect.objectContaining({ tabId, active: true, routable: true, state: "live" }),
    ]);
    const finalStatus = await mcp.call("browser_status");
    expect(finalStatus.structuredContent).toMatchObject({
      assignedTabId: tabId,
      authorization: "not-required",
    });

    const closed = await mcp.call("browser_close", { idempotencyKey: key() });
    expect(closed.structuredContent).toEqual({ closedTabId: tabId, activeTabId: null });
    const tabsAfterClose = await mcp.call("browser_tabs");
    expect(tabsAfterClose.structuredContent).toMatchObject({
      assignedTabId: null,
      activeTabId: null,
      tabs: [],
    });
    const runtimeCount = await electronApp.evaluate(() => {
      const manager = (
        globalThis as typeof globalThis & {
          __synaraVisibleBrowserE2E: { browserManager: { runtimes: Map<string, unknown> } };
        }
      ).__synaraVisibleBrowserE2E.browserManager;
      return manager.runtimes.size;
    });
    expect(runtimeCount).toBe(0);
  } finally {
    try {
      await closeElectronApplication(electronApp);
    } finally {
      await site.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

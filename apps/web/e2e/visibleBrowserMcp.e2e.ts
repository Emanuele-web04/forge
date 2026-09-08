import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("production MCP controls one persistent Electron page across visibility changes", async () => {
  const mainPath = process.env.SYNARA_E2E_ELECTRON_MAIN;
  if (!mainPath) throw new Error("Electron E2E main bundle was not prepared.");
  const site = await startVisibleBrowserFixtureSite();
  const home = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "synara-mcp-"));
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
    expect((await mcp.listTools()).map((tool) => tool.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
      "synara_e2e_review",
    ]);
    const guidance = await mcp.call("synara_e2e_review");
    expect(JSON.stringify(guidance.content)).toMatch(/subagent/i);
    expect(JSON.stringify(guidance.content)).toContain("proof");

    const run = (code: string, timeoutMs = 10_000) =>
      mcp.call("browser_run", { code, timeoutMs, idempotencyKey: key() });
    const read = async (expression: string) =>
      (await run(`return await page.evaluate(() => (${expression}));`)).structuredContent.value;
    const waitForText = (value: string) =>
      run(
        `await page.getByText(${JSON.stringify(value)}).waitFor({state:"visible"}); return true;`,
      );
    const click = (name: string) =>
      run(
        `await human.click(page.getByRole("button", {name:${JSON.stringify(name)},exact:true})); return true;`,
      );

    expect((await mcp.call("browser_status")).structuredContent).toMatchObject({
      available: true,
      physicalScope: "visible-shared-electron-webview",
      authorization: "not-required",
    });
    const opened = await mcp.call("browser_open", {
      url: site.initialUrl,
      show: true,
      reuse: true,
    });
    const tabId = String(opened.structuredContent.tabId);
    await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", tabId);
    const initialRuntime = await runtimeDetails(tabId);
    expect(initialRuntime.url).toBe(site.initialUrl);

    await test.step("keeps the same native page while hidden and navigating", async () => {
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(false);
      });
      await run(
        'return await page.evaluate(() => document.body.dataset.backgroundAgent = "continued");',
      );
      expect(await read("document.body.dataset.backgroundAgent")).toBe("continued");
      expect((await runtimeDetails(tabId)).id).toBe(initialRuntime.id);
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(true);
      });
      const navigated = await mcp.call("browser_navigate", { url: site.appUrl });
      expect(navigated.structuredContent).toMatchObject({ tabId, finalUrl: site.appUrl });
      await run(
        `return await page.evaluate(() => { location.href = ${JSON.stringify(site.nextUrl)}; return true; });`,
      );
      await run(`await page.waitForURL(${JSON.stringify(site.nextUrl)}); return true;`);
      expect((await runtimeDetails(tabId)).url).toBe(site.nextUrl);
      expect((await runtimeDetails(tabId)).id).toBe(initialRuntime.id);
      await mcp.call("browser_navigate", { tabId, url: site.appUrl });
      expect(await read("document.body.dataset.agentClicks")).toBe("0");
    });

    await test.step("returns bounded observations and durable screenshot proof", async () => {
      const resized = await mcp.call("browser_resize", { width: 760, height: 520 });
      expect(resized.structuredContent).toMatchObject({
        tabId,
        requested: { width: 760, height: 520 },
        observed: { height: 520 },
      });
      expect(
        (resized.structuredContent.observed as { width: number }).width,
      ).toBeGreaterThanOrEqual(740);
      await waitForText("Delayed fixture ready");
      const observed = await run("return await snapshot({interactive:true});");
      expect(observed.content.some((item) => item.type === "image")).toBe(false);
      expect(JSON.stringify(observed.structuredContent.value)).toContain("Shared input");
      for (const fullPage of [false, true]) {
        const screenshot = await mcp.call("browser_screenshot", { fullPage, kind: "proof" });
        expect(screenshot.structuredContent).toMatchObject({
          tabId,
          mode: fullPage ? "fullPage" : "viewport",
          image: { mimeType: "image/png" },
        });
        const png = screenshot.content.find((item) => item.type === "image");
        const bytes = Buffer.from(String(png?.data), "base64");
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const artifactPath = String(screenshot.structuredContent.artifactPath);
        expect(artifactPath.startsWith(join(workspaceRoot, "proof"))).toBe(true);
        expect(readFileSync(artifactPath)).toEqual(bytes);
        if (fullPage)
          expect((screenshot.structuredContent.image as { height: number }).height).toBeGreaterThan(
            2000,
          );
      }
    });

    await test.step("performs trusted hover, select, workspace upload and drag", async () => {
      await run(
        'await page.getByRole("button",{name:"Reveal hover state",exact:true}).hover(); return true;',
      );
      expect(
        await read(
          '({visibility:getComputedStyle(document.querySelector("#hover-result")).visibility,trusted:document.querySelector("#hover-result").dataset.trusted})',
        ),
      ).toEqual({ visibility: "visible", trusted: "true" });
      await run(
        'await page.getByLabel("Fixture choice",{exact:true}).selectOption("beta"); return true;',
      );
      await waitForText("Selected: beta");
      const target = { locator: { kind: "label", text: "Fixture upload", exact: true } };
      const uploaded = await mcp.call("browser_upload", { target, paths: ["fixture-upload.txt"] });
      expect(uploaded.structuredContent.files).toEqual([
        { name: "fixture-upload.txt", byteLength: 23 },
      ]);
      await waitForText("Uploaded: fixture-upload.txt:23");
      await expect(
        mcp.call("browser_upload", { target, paths: ["outside-link.txt"] }),
      ).rejects.toThrow(/BrowserUploadPathOutsideWorkspace/);
      await run('await page.locator("#drop-target").scrollIntoViewIfNeeded(); return true;');
      await run(
        'await page.locator("#drag-source").dragTo(page.locator("#drop-target"), {steps:8}); return true;',
      );
      const dragState = await read(
        '({state:document.querySelector("#drag-state").textContent,start:document.body.dataset.dragstart,end:document.body.dataset.dragend,drop:document.body.dataset.drop,down:document.body.dataset.dragMousedown,move:document.body.dataset.dragMousemove,buttons:document.body.dataset.dragButtons,focused:document.hasFocus(),source:document.querySelector("#drag-source").getBoundingClientRect().toJSON(),target:document.querySelector("#drop-target").getBoundingClientRect().toJSON()})',
      );
      expect(dragState, JSON.stringify(dragState)).toMatchObject({ state: "Dragged: yes" });
      await waitForText("Dragged: yes");
    });

    await test.step("handles dialogs, excludes network secrets and blocks downloads", async () => {
      for (const [name, kind, action, result] of [
        ["Open alert dialog", "alert", "accepted", "alert-continued"],
        ["Open confirm dialog", "confirm", "dismissed", "confirm-false"],
        ["Open prompt dialog", "prompt", "dismissed", "prompt-null"],
      ]) {
        const clicked = await click(name!);
        expect(clicked.structuredContent.dialogs).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind, action })]),
        );
        await waitForText(`Dialog result: ${result}`);
      }
      await click("Emit fixture logs");
      await run(
        'await page.locator("body[data-logs-emitted=true]").waitFor({state:"attached"}); return true;',
      );
      const logs = JSON.stringify(
        (await mcp.call("browser_logs", { limit: 200 })).structuredContent,
      );
      expect(logs).toContain("Fixture console warning");
      expect(logs).toContain("/api/fixture");
      expect(logs).not.toContain("SECRET_HEADER_MUST_NOT_LEAK");
      expect(logs).not.toContain("SECRET_BODY_MUST_NOT_LEAK");
      await expect(
        run(
          'await human.click(page.getByRole("link",{name:"Download fixture",exact:true})); return true;',
        ),
      ).rejects.toThrow(/BrowserDownloadApprovalRequired/);
      expect(existsSync(join(home, "Downloads", "fixture-download.txt"))).toBe(false);
    });

    await test.step("keeps OAuth and target-blank popups inside the app", async () => {
      for (const [name, url, role] of [
        ["Open OAuth popup", "/oauth", "button"],
        ["Open fixture tab", "/popup", "link"],
      ]) {
        await run(
          `await human.click(page.getByRole(${JSON.stringify(role)},{name:${JSON.stringify(name)},exact:true})); return true;`,
        );
        const tabs = (await mcp.call("browser_tabs")).structuredContent;
        expect(tabs.tabs).toHaveLength(2);
        const popupTab = (tabs.tabs as { tabId: string; url: string }[]).find(
          (tab) => tab.tabId !== tabId,
        );
        expect(popupTab).toBeDefined();
        const popupTabId = popupTab!.tabId;
        await mcp.call("browser_run", { tabId: popupTabId, code: "return page.url();" });
        await expect
          .poll(async () => (await runtimeDetails(popupTabId)).url)
          .toBe(new URL(url!, site.appUrl).href);
        expect(
          await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        ).toBe(1);
        expect(tabs.activeTabId).toBe(popupTabId);
        const closed = await mcp.call("browser_close", { tabId: popupTabId });
        expect(closed.structuredContent).toMatchObject({
          closedTabId: popupTabId,
          activeTabId: tabId,
        });
        await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", tabId);
      }
    });

    await test.step("preserves history and rejects unsupported navigation", async () => {
      await mcp.call("browser_navigate", { tabId, url: site.nextUrl, waitUntil: "load" });
      expect((await mcp.call("browser_back", { tabId })).structuredContent.finalUrl).toBe(
        site.appUrl,
      );
      expect((await mcp.call("browser_forward", { tabId })).structuredContent.finalUrl).toBe(
        site.nextUrl,
      );
      expect(
        (await mcp.call("browser_reload", { tabId, ignoreCache: true })).structuredContent.finalUrl,
      ).toBe(site.nextUrl);
      const redirected = await mcp.call("browser_navigate", { tabId, url: site.redirectUrl });
      expect(redirected.structuredContent.finalUrl).toBe(site.nextUrl);
      expect(redirected.structuredContent.redirects).toContain(site.redirectUrl);
      await expect(
        mcp.call("browser_navigate", { tabId, url: "file:///etc/passwd" }),
      ).rejects.toThrow(/BrowserNavigationBlocked/);
      await mcp.call("browser_navigate", { tabId, url: site.appUrl });
      // Locator clicks enforce actionability; human.click is a lower-level pointer operation.
      for (const name of ["Disabled action", "Covered action"]) {
        await expect(
          run(
            `await page.getByRole("button",{name:${JSON.stringify(name)},exact:true}).click({timeout:500}); return true;`,
          ),
        ).rejects.toThrow(/BrowserEvaluationFailed|BrowserTimeout/);
      }
      expect(await read("document.body.dataset.agentClicks")).toBe("0");
    });

    await test.step("keeps native input in the guest and returns compact observations", async () => {
      await run(
        'return await page.evaluate(() => { document.querySelector("#state").setAttribute("data-unrelated-mutation","true"); return true; });',
      );
      await click("Commit agent action");
      const point = (await read(
        '(() => {const r=document.querySelector("#point").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()',
      )) as { x: number; y: number };
      await run(`await page.mouse.click(${point.x},${point.y}); return true;`);
      await waitForText("Point clicks: 1");
      await run(
        'return await page.evaluate(() => {const fragment=document.createDocumentFragment();for(let i=0;i<300;i++){const button=document.createElement("button");button.textContent="Offscreen action "+i;button.style.cssText="position:absolute;top:"+(1000+i*36)+"px";fragment.append(button);}document.body.append(fragment);return true;});',
      );
      const compact = await run('return await snapshot({interactive:true,selector:"main"});');
      expect(Buffer.byteLength(JSON.stringify(compact.structuredContent))).toBeLessThan(36_000);
      const hostComposer = page.getByLabel("Host composer");
      await hostComposer.fill("HOST_SENTINEL");
      await hostComposer.focus();
      await run(
        'await human.type(page.getByLabel("Shared input",{exact:true}),"shared-through-mcp",{clear:true}); return true;',
      );
      await expect(hostComposer).toHaveValue("HOST_SENTINEL");
      await run('await page.keyboard.press("ControlOrMeta+A"); return true;');
      await run('await page.keyboard.press("Backspace"); return true;');
      await run('await page.keyboard.press("x"); return true;');
      expect(await read('document.querySelector("input").value')).toBe("x");
      await run(
        'await human.type(page.getByLabel("Shared input",{exact:true}),"shared-through-mcp",{clear:true}); return true;',
      );
      await run('await page.keyboard.press("Enter"); return true;');
      await expect(hostComposer).toHaveValue("HOST_SENTINEL");
      await expect(page.locator("html")).toHaveAttribute("data-host-submits", "0");
      await run("await human.scroll({deltaY:1000,deltaX:0}); return true;");
      await expect.poll(() => read("scrollY")).toBeGreaterThan(0);
    });

    await test.step("yields to human input and recovers after MCP cancellation", async () => {
      await sendNativeInput(tabId, { type: "mouseMove", x: 30, y: 30 });
      for (let step = 0; step < 32; step++)
        await sendNativeInput(tabId, {
          type: "mouseWheel",
          x: 30,
          y: 30,
          deltaY: 1000,
          canScroll: true,
        });
      await expect.poll(() => read("scrollY"), { timeout: 3000 }).toBe(0);
      const rect = (await read(
        '(() => {const r=document.querySelector("#manual").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()',
      )) as { x: number; y: number };
      const interrupted = run(
        'await page.getByText("Human takeover sentinel never appears").waitFor(); return true;',
        5000,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const point = { x: Math.round(rect.x), y: Math.round(rect.y) };
      await sendNativeInput(tabId, { type: "mouseMove", ...point });
      await sendNativeInput(tabId, { type: "mouseDown", ...point, button: "left", clickCount: 1 });
      await sendNativeInput(tabId, { type: "mouseUp", ...point, button: "left", clickCount: 1 });
      expect(String(await interrupted)).toContain("BrowserInterruptedByHuman");
      await waitForText("Manual clicks: 1");
      expect(
        await read(
          '({value:document.querySelector("input").value,agentClicks:document.body.dataset.agentClicks,pointClicks:document.body.dataset.pointClicks,manualClicks:document.body.dataset.manualClicks,presses:document.body.dataset.presses,cookie:document.cookie})',
        ),
      ).toEqual({
        value: "shared-through-mcp",
        agentClicks: "1",
        pointClicks: "1",
        manualClicks: "1",
        presses: "1",
        cookie: expect.stringContaining("shared_cookie=agent"),
      });
      await mcp.cancelCall("browser_run", {
        code: 'await page.getByText("Cancellation sentinel never appears").waitFor(); return true;',
        timeoutMs: 10_000,
      });
      expect(await read("document.title")).toBe("Visible browser fixture");
      const tabs = (await mcp.call("browser_tabs")).structuredContent;
      expect(tabs).toMatchObject({ activeTabId: tabId, assignedTabId: tabId });
      expect(tabs.tabs).toEqual([
        expect.objectContaining({ tabId, active: true, routable: true, state: "live" }),
      ]);
      expect((await mcp.call("browser_close")).structuredContent).toEqual({
        closedTabId: tabId,
        activeTabId: null,
      });
      expect((await mcp.call("browser_tabs")).structuredContent).toMatchObject({
        assignedTabId: null,
        activeTabId: null,
        tabs: [],
      });
      expect(
        await electronApp.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __synaraVisibleBrowserE2E: { browserManager: { runtimes: Map<string, unknown> } };
              }
            ).__synaraVisibleBrowserE2E.browserManager.runtimes.size,
        ),
      ).toBe(0);
    });
  } finally {
    try {
      await closeElectronApplication(electronApp);
    } finally {
      await site.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

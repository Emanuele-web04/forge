import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@synara/contracts";
import { DesktopBrowserManager } from "../src/browserManager";

// Run the bundled script with Electron. Everything is synthetic and the only
// native window stays hidden; no existing Synara profile or login is touched.
void (async () => {
  const home = mkdtempSync(join(tmpdir(), "synara-hidden-popup-test-"));
  process.env.SYNARA_HOME = home;
  app.setPath("userData", home);
  const watchdog = setTimeout(() => {
    console.error("Embedded popup smoke timed out");
    app.exit(1);
  }, 30_000);
  watchdog.unref();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(request.url === "/popup"
      ? '<h1>Synthetic sign-in</h1><input value="retained"><script>window.finish=()=>{window.opener.postMessage("synthetic-complete",location.origin);window.close();};</script>'
      : '<h1>Synthetic opener</h1><script>window.completed=false;window.addEventListener("message",e=>{if(e.origin===location.origin&&e.data==="synthetic-complete")window.completed=true;});</script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const manager = new DesktopBrowserManager();
  manager.setWindow(window);
  const threadId = ThreadId.makeUnsafe("synthetic-popup-thread");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let exitCode = 0;
  const waitFor = async (test: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!await test()) {
      if (Date.now() > deadline) throw new Error("Synthetic popup observation timed out");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    const state = manager.open({ threadId, initialUrl: origin });
    manager.setPanelBounds({ threadId, surface: "native", bounds: { x: 0, y: 50, width: 1000, height: 750 } });
    const source = await manager.getAutomationRuntime({ threadId, tabId: state.activeTabId! });
    await source.webContents.loadURL(origin);
    manager.setPanelBounds({ threadId, surface: "native", preview: true, bounds: { x: 200, y: 100, width: 320, height: 200 } });
    await waitFor(async () => Boolean((await manager.capturePreview({ threadId, tabId: source.tabId }))?.startsWith("data:image/jpeg;base64,")));
    assert.ok(window.contentView.children.some(view => view.getBounds().x === -10000), "Preview page is outside native hit testing");
    manager.setPanelBounds({ threadId, surface: "native", bounds: { x: 0, y: 50, width: 1000, height: 750 } });
    assert.equal(manager.getVisibleAutomationRuntime({ threadId, tabId: source.tabId }).webContents, source.webContents);
    assert.equal(await manager.capturePreview({ threadId, tabId: source.tabId }), null);
    await source.webContents.executeJavaScript('window.open("/popup", "auth", "width=480,height=640"); true;', true);
    await waitFor(() => manager.getState({ threadId }).tabs.length === 2);
    const popup = manager.getState({ threadId }).tabs.find(tab => tab.openerTabId === source.tabId);
    assert.ok(popup);
    assert.equal(popup.runtimeSurface, "native");
    await waitFor(() => manager.getState({ threadId }).activeTabId === popup.id);
    const child = manager.getVisibleAutomationRuntime({ threadId, tabId: popup.id }).webContents;
    await waitFor(async () => !child.isLoading() && await child.executeJavaScript('typeof window.finish === "function"'));
    assert.equal(BrowserWindow.getAllWindows().length, 1, "No external popup window");
    assert.equal(await child.executeJavaScript("Boolean(window.opener)"), true);
    assert.equal(child.session, source.webContents.session);
    assert.deepEqual(await child.executeJavaScript("[innerWidth, innerHeight]"), [1000, 750]);
    const image = await child.capturePage();
    assert.equal(image.isEmpty(), false);
    const pixels = image.toBitmap();
    assert.ok(pixels.some(value => value !== pixels[0]), "Popup renders nonblank pixels");
    await child.executeJavaScript("window.finish(); true;").catch(() => {});
    await waitFor(() => manager.getState({ threadId }).tabs.length === 1);
    await waitFor(() => source.webContents.executeJavaScript("window.completed"));
    assert.equal(manager.getState({ threadId }).activeTabId, source.tabId);
    console.log("PASS: embedded rendering, original opener, shared session, postMessage callback, close returns to opener, no external window");
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.message : "Synthetic popup failure");
  } finally {
    manager.dispose();
    window.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    clearTimeout(watchdog);
    app.exit(exitCode);
  }
})().catch(error => {
  console.error(error instanceof Error ? error.message : "Synthetic popup setup failure");
  app.exit(1);
});

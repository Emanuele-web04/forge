import { app, BrowserWindow, WebContentsView, clipboard } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runBetterwright } from "../src/browserAutomation/betterwrightRuntime";

const home = path.resolve(process.env.SYNARA_SMOKE_HOME ?? ".synara-betterwright-smoke");
app.setPath("userData", path.join(home, "electron"));
async function smoke() {
  await mkdir(home, { recursive: true });
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  const unrelated = new BrowserWindow({ show: false });
  await unrelated.loadURL("data:text/html,<title>Unrelated target</title><p>Untouched</p>");
  await window.loadURL("data:text/html,<label>Composer<input autofocus></label>");
  const view = new WebContentsView({
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 80, width: 1000, height: 600 });
  const contents = view.webContents;
  contents.session.on("will-download", (_event, item) => item.cancel());
  await contents.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<!doctype html><title>Synara browser fixture</title><style>body{font:18px system-ui;padding:48px;color:#171717}input,button{font:inherit;padding:12px}output{display:block;margin-top:24px}</style><h1>Browser integration fixture</h1><label>Message <input></label> <button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output>Waiting</output>`,
      ),
  );
  const options = { home: path.join(home, "worker"), contents, timeoutMs: 10_000 };
  const result = await runBetterwright<{ title: string; value: string; snapshot: unknown }>({
    ...options,
    signal: new AbortController().signal,
    code: "await page.getByRole('textbox').fill('Betterwright'); await page.getByRole('button', {name:'Apply'}).click(); return {title: await page.title(), value: await page.locator('output').textContent(), snapshot: await snapshot()};",
  });
  if (result.value !== "Betterwright") throw new Error("Expected real fill and click outcome.");
  if (window.isDestroyed() || unrelated.isDestroyed())
    throw new Error("Worker closed a user-owned window.");
  if (unrelated.getTitle() !== "Unrelated target") throw new Error("Unrelated target changed.");
  await writeFile(path.join(home, "browser.png"), (await window.webContents.capturePage()).toPNG());

  clipboard.writeText("synthetic-native-clipboard-smoke");
  const keyboard = await runBetterwright<{ value: string }>({
    ...options,
    signal: new AbortController().signal,
    code: `await page.getByRole('textbox').fill(''); await page.keyboard.press('ControlOrMeta+V'); await page.keyboard.press('a'); return { value: await page.getByRole('textbox').inputValue() };`,
  });
  if (keyboard.value !== "synthetic-native-clipboard-smokea")
    throw new Error("Shared clipboard or modifier cleanup failed.");
  await contents.executeJavaScript("document.querySelector('input').focus()");
  window.webContents.focus();
  await window.webContents.executeJavaScript("document.querySelector('input').focus()");
  const focus = await runBetterwright<boolean>({
    ...options,
    signal: new AbortController().signal,
    code: "await page.keyboard.insertText('synthetic-focus'); return (await page.getByRole('textbox').inputValue()).endsWith('synthetic-focus');",
  });
  if (
    !focus ||
    (await window.webContents.executeJavaScript("document.querySelector('input').value !== ''"))
  )
    throw new Error("Native guest focus isolation failed.");

  const controller = new AbortController();
  const cancelled = runBetterwright({
    ...options,
    signal: controller.signal,
    code: "await page.evaluate(() => { window.cancelStarted = true; }); await page.waitForTimeout(5000); await page.evaluate(() => { window.lateMutation = true; });",
  }).then(
    () => false,
    () => true,
  );
  const deadline = Date.now() + 15_000;
  while (!(await contents.executeJavaScript("window.cancelStarted === true"))) {
    if (Date.now() > deadline) throw new Error("Cancellation probe never entered the page.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  controller.abort(new Error("Synthetic human takeover."));
  if (!(await cancelled)) throw new Error("Cancellation did not reject.");
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (await contents.executeJavaScript("window.lateMutation === true")) {
    throw new Error("Worker mutated the page after cancellation.");
  }
  if (window.isDestroyed() || unrelated.isDestroyed())
    throw new Error("Cancellation closed a window.");
  const report = {
    result,
    keyboard: "passed",
    nativeFocus: "passed",
    cancellation: "passed",
    unrelatedTarget: "untouched",
    hostWindows: "alive",
  };
  await writeFile(path.join(home, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

void app
  .whenReady()
  .then(smoke)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );

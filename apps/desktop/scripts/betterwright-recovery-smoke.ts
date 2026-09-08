import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBetterwright } from "../src/browserAutomation/betterwrightRuntime";

const home = mkdtempSync(join(tmpdir(), "synara-browser-recovery-"));
app.setPath("userData", join(home, "electron"));
const watchdog = setTimeout(() => app.exit(1), 60_000);

async function smoke() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><title>Recovery fixture</title><button disabled>Disabled action</button><button onclick="document.body.dataset.clicked=1">Enabled action</button>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "synthetic-recovery",
    },
  });
  try {
    await window.loadURL(`http://127.0.0.1:${address.port}`);
    const run = (code: string, signal = new AbortController().signal) =>
      runBetterwright({
        home: join(home, "worker"),
        contents: window.webContents,
        timeoutMs: 5000,
        signal,
        code,
      });
    console.log("Recovery: locator failure");
    await assert.rejects(
      run(
        'await page.getByRole("button",{name:"Disabled action",exact:true}).click({timeout:500}); return true;',
      ),
    );
    assert.equal(await run("return page.title()"), "Recovery fixture");
    console.log("Recovery: worker timeout");
    await assert.rejects(
      run(
        'await page.getByText("Never appears").waitFor({timeout:20000}); await page.getByRole("button",{name:"Enabled action",exact:true}).click(); return true;',
      ),
    );
    assert.equal(
      await run('return page.evaluate(() => document.body.dataset.clicked ?? "0")'),
      "0",
    );
    console.log("Recovery: cancellation");
    const controller = new AbortController();
    const pending = run(
      'await page.getByText("Never appears").waitFor(); await page.getByRole("button",{name:"Enabled action",exact:true}).click(); return true;',
      controller.signal,
    );
    const rejection = assert.rejects(pending);
    setTimeout(() => controller.abort(new Error("Synthetic cancellation")), 500);
    await rejection;
    assert.equal(
      await run('return page.evaluate(() => document.body.dataset.clicked ?? "0")'),
      "0",
    );
    console.log(
      "PASS: locator failure, worker timeout and cancellation recover on the same native page without a late click",
    );
  } finally {
    window.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(watchdog);
  }
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

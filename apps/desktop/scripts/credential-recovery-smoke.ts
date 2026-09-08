import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { runBetterwright } from "../src/browserAutomation/betterwrightRuntime";
import { BrowserVault } from "../src/browserAutomation/browserVault";
import { browserEvaluationOutput } from "../src/browserAutomation/waitAndEvaluate";

// Hidden, synthetic-only regression for PR #1028. Never attaches to a user tab.
const home = mkdtempSync(join(tmpdir(), "synara-credential-boundary-"));
app.setPath("userData", join(home, "electron"));
process.env.SYNARA_HOME = home;
const watchdog = setTimeout(() => {
  console.error("Credential boundary smoke timed out; no credential values logged.");
  app.exit(1);
}, 90_000);

async function smoke() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><title>Synthetic login</title><form><label>Email<input name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "synthetic-credential-boundary",
    },
  });
  const vault = new BrowserVault(join(home, "saved-logins"));
  let stage = "setup";
  try {
    const secret = "SyntheticRegressionOnly-NotARealPassword42!";
    const master = "SyntheticRegressionMaster42!";
    await vault.setupMaster(master);
    await vault.configure({ agentUse: true, offerSave: true, autosave: false });
    await vault.saveCaptured(
      origin,
      { username: "fixture@example.test", password: secret },
      "user",
    );
    const before = await vault.snapshot();
    const id = before.logins[0]!.id;
    await window.loadURL(origin);
    const signal = new AbortController().signal;
    const options = {
      home: join(home, "worker"),
      contents: window.webContents,
      timeoutMs: 20_000,
      signal,
      vault: vault.agentAdapter(window.webContents, signal),
    };
    const run = async (code: string) =>
      vault.redact(
        browserEvaluationOutput("synthetic", await runBetterwright({ ...options, code })),
      ).value;

    stage = "metadata discovery";
    const listed = await run("return credentials.list()");
    assert.ok(JSON.stringify(listed).includes("fixture@example.test"));
    assert.ok(!JSON.stringify(listed).includes(secret));

    stage = "preinstalled listener";
    await run(
      "return page.evaluate(() => { window.observedPassword = ''; document.querySelector('input[type=password]').addEventListener('input', event => { window.observedPassword = event.target.value }); return true })",
    );
    const targets = `id:${JSON.stringify(id)},usernameSelector:'input[name=email]',passwordSelector:'input[name=password]'`;
    stage = "fill and generation denied";
    for (const code of [
      `return credentials.fill({${targets}})`,
      `return credentials.fill({${targets},submit:true})`,
      "return credentials.generateAndFill({username:'fixture@example.test',usernameSelector:'input[name=email]',passwordSelector:'input[name=password]'})",
    ]) {
      await assert.rejects(run(code), (error: unknown) => {
        const actual =
          error && typeof error === "object" && "browserError" in error
            ? (error.browserError as { code: string }).code
            : "unknown";
        stage = `fill and generation denied (${actual})`;
        return actual === "BrowserCredentialUseUnavailable";
      });
    }

    stage = "same-call encoded read";
    const points = await run(
      `await credentials.fill({${targets}}).catch(() => null); return page.evaluate(() => Array.from(document.querySelector('input[type=password]').value, c => c.codePointAt(0)))`,
    ).catch(() => []);
    assert.deepEqual(points, []);
    stage = "cross-call encoded reads";
    const encoded = await run(
      "return page.evaluate(() => ({ encoded: btoa(document.querySelector('input[type=password]').value), intercepted: btoa(window.observedPassword) }))",
    );
    assert.deepEqual(encoded, { encoded: "", intercepted: "" });
    stage = "unchanged vault";
    assert.deepEqual(await vault.snapshot(), before);

    stage = "ordinary input and owner access";
    await run(
      "await human.type(page.locator('input[name=email]'),'ordinary@example.test',{clear:true}); return true",
    );
    assert.equal(
      await run("return page.evaluate(() => document.querySelector('input[name=email]').value)"),
      "ordinary@example.test",
    );
    assert.equal((await vault.reveal({ id, password: master })).password, secret);
    await vault.configure({ agentUse: false, offerSave: true, autosave: false });
    await assert.rejects(run("return credentials.list()"));
    await vault.remove(id);
    assert.equal((await vault.snapshot()).logins.length, 0);
    stage = "empty metadata discovery";
    await vault.configure({ agentUse: true, offerSave: true, autosave: false });
    assert.deepEqual(await run("return await credentials.list()"), []);
    assert.deepEqual(await run("return await credentials.listPending()"), []);
    console.log(
      "PASS: metadata discovery, fill/generate denial, encoded reads, preinstalled listener, ordinary input, owner reveal/delete; synthetic credentials only",
    );
  } catch {
    throw new Error(`Credential boundary smoke failed during ${stage}; credential values omitted.`);
  } finally {
    vault.dispose();
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
      console.error(error.message);
      app.exit(1);
    },
  );

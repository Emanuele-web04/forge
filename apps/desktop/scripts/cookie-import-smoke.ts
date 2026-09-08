import { app, WebContentsView } from "electron";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BetterWright, NetworkPolicy } from "betterwright";
import { openBetterwrightConnection } from "../src/browserAutomation/betterwrightConnection";

void (async () => {
  const home = await mkdtemp(join(tmpdir(), "synara-import-native-"));
  app.setPath("userData", join(home, "electron"));
  await app.whenReady();
  // Generate the source here so this smoke can never select a personal profile.
  // Resolve from this module so the fixture is found from any working directory.
  process.env.HOME = execFileSync(
    "node",
    [join(import.meta.dirname, "synthetic-cookie-profile.mjs")],
    { encoding: "utf8" },
  ).trim();
  const view = new WebContentsView({
    webPreferences: { partition: "persist:import-smoke", sandbox: true, contextIsolation: true },
  });
  await view.webContents.loadURL("about:blank");
  const connection = await openBetterwrightConnection(view.webContents, undefined, [], true);
  const browser = new BetterWright({
    home: join(home, "worker"),
    provider: connection.provider,
    hostOwnedTarget: true,
    vault: false,
    credentialCapture: false,
    downloadPolicy: "deny",
    adBlock: false,
    parkBackgroundPages: false,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const result = await browser.syncCookies({
      source: { browser: "safari", profile: "default" },
      windowsAppBound: "disabled",
      timeoutMs: 30_000,
      cloudConsent: `cdp:${new URL(connection.provider.cdpUrl).host}`,
    });
    assert.ok(result.ok, "Synthetic native import failed");
    if (!result.ok) return;
    assert.equal(result.synced, 1);
    assert.deepEqual(result.cookieImportDomains, ["127.0.0.1"]);
    const stored = await view.webContents.session.cookies.get({ name: "synara_synthetic_import" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.value, "synthetic-only");
    console.log("Native fixture import and stored-domain metadata passed");
  } finally {
    await connection.close(false);
    await browser.close();
    view.webContents.close();
  }
})().then(
  () => app.exit(0),
  () => {
    console.error("Native fixture import smoke failed");
    app.exit(1);
  },
);

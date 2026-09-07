const { app, safeStorage } = require("electron");
const { existsSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, sep } = require("node:path");

const home = realpathSync(process.env.SYNARA_COOKIE_FIXTURE_HOME);
if (!home.startsWith(`${realpathSync(tmpdir())}${sep}synara-cookie-fixture-`) || !existsSync(join(home, "Library", "Cookies", "Cookies.binarycookies"))) {
  throw new Error("Use a fresh profile from synthetic-cookie-profile.mjs.");
}

// Initialize macOS encryption normally, then isolate native cookie discovery.
// The compiled app and Betterwright reader are not mocked or replaced.
app.once("ready", () => {
  if (safeStorage.isEncryptionAvailable()) safeStorage.encryptString("synthetic-launch-check");
  process.env.HOME = home;
});
require("../dist-electron/main.js");

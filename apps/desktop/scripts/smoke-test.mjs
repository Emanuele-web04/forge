import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNARA_DESKTOP_SMOKE_USER_DATA_ENV } from "@synara/shared/desktopIdentity";
import { spawnSourceDesktop } from "./source-desktop-launch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const electronBin = resolve(desktopDir, "node_modules/.bin/electron");
const smokeHome = mkdtempSync(join(tmpdir(), "synara-desktop-smoke-"));

console.log("\nLaunching Electron smoke test...");

const child = spawnSourceDesktop({
  desktopDirectory: desktopDir,
  electronPath: electronBin,
  spawnProcess: spawn,
  stdio: ["pipe", "pipe", "pipe"],
  environment: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    SYNARA_HOME: smokeHome,
    [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: join(smokeHome, "electron-user-data"),
    VITE_DEV_SERVER_URL: "",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  child.kill();
}, 8_000);

function finish(exitCode) {
  rmSync(smokeHome, { recursive: true, force: true });
  process.exit(exitCode);
}

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error("Desktop smoke test failed to launch:", error);
  finish(1);
});

child.on("exit", () => {
  clearTimeout(timeout);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    finish(1);
  }

  console.log("Desktop smoke test passed.");
  finish(0);
});

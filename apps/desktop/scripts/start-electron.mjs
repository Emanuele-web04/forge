import { spawn } from "node:child_process";

import { buildAppSnapHelper } from "./build-appsnap-helper.mjs";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { spawnSourceDesktop } from "./source-desktop-launch.mjs";

if (process.platform === "darwin") {
  buildAppSnapHelper({ arch: process.arch });
}

const child = spawnSourceDesktop({
  desktopDirectory: desktopDir,
  electronPath: resolveElectronPath(),
  spawnProcess: spawn,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

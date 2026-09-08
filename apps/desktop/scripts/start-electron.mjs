import { spawn } from "node:child_process";

import { buildAppSnapHelper } from "./build-appsnap-helper.mjs";
import { buildComputerHelper } from "./build-computer-helper.mjs";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { spawnSourceDesktop } from "./source-desktop-launch.mjs";

if (process.platform === "darwin") {
  buildAppSnapHelper({ arch: process.arch });
  // The desktop permission preflight runs the helper bundle, not Electron, so a
  // dev build needs one on disk or every probe falls back to reporting
  // Electron's own grants. Built with optimization so what you exercise here is
  // what ships — the difference is small but real, and the fingerprint cache
  // makes it a one-time cost. Pass SYNARA_COMPUTER_HELPER_OPTIMIZE=debug to
  // build.sh directly when iterating on the Swift itself.
  buildComputerHelper({ arch: process.arch });
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

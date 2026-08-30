import { homedir } from "node:os";
import { join } from "node:path";

import { resolveSynaraDesktopFlavor, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

function sourceDesktopEnvironment(environment, homeDirectory) {
  const flavor = resolveSynaraDesktopFlavor({
    isDevelopment: true,
    requestedFlavor: environment.SYNARA_DESKTOP_FLAVOR,
  });
  const identity = synaraDesktopIdentity(flavor);
  const childEnvironment = {
    ...environment,
    SYNARA_DESKTOP_FLAVOR: flavor,
    SYNARA_HOME:
      environment.SYNARA_HOME?.trim() || join(homeDirectory, identity.defaultHomeDirectoryName),
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  return childEnvironment;
}

export function spawnSourceDesktop({
  desktopDirectory,
  electronPath,
  environment = process.env,
  homeDirectory = homedir(),
  spawnProcess,
}) {
  return spawnProcess(electronPath, ["dist-electron/main.js"], {
    cwd: desktopDirectory,
    env: sourceDesktopEnvironment(environment, homeDirectory),
    stdio: "inherit",
  });
}

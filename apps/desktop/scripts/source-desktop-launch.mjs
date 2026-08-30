import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveSynaraDesktopFlavor,
  SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
  synaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import { readWindowsPersistentEnvironment } from "@synara/shared/shell";

function configuredSourceDesktopHome(environment, platform, readWindowsEnvironment) {
  const inheritedHome = environment.SYNARA_HOME?.trim();
  if (inheritedHome) return inheritedHome;
  if (platform !== "win32") return undefined;

  try {
    return readWindowsEnvironment().SYNARA_HOME?.trim();
  } catch {
    return undefined;
  }
}

export function createSourceDesktopEnvironment({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  readWindowsEnvironment = readWindowsPersistentEnvironment,
} = {}) {
  const flavor = resolveSynaraDesktopFlavor({
    isDevelopment: true,
    requestedFlavor: environment.SYNARA_DESKTOP_FLAVOR,
  });
  const identity = synaraDesktopIdentity(flavor);
  const configuredHome = configuredSourceDesktopHome(environment, platform, readWindowsEnvironment);
  const childEnvironment = {
    ...environment,
    SYNARA_DESKTOP_FLAVOR: flavor,
    SYNARA_HOME: configuredHome || join(homeDirectory, identity.defaultHomeDirectoryName),
    SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  return childEnvironment;
}

function assertCurrentSourceDesktopBuild(desktopDirectory, readBuiltMain) {
  const builtMainPath = join(desktopDirectory, "dist-electron/main.js");
  const builtMain = readBuiltMain(builtMainPath, "utf8");
  if (!builtMain.includes(SYNARA_SOURCE_DESKTOP_BUILD_MARKER)) {
    throw new Error(
      "Source desktop build is stale. Run `bun run start:desktop` to rebuild it before launching.",
    );
  }
}

export function spawnSourceDesktop({
  desktopDirectory,
  electronPath,
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  readBuiltMain = readFileSync,
  readWindowsEnvironment = readWindowsPersistentEnvironment,
  spawnProcess,
}) {
  assertCurrentSourceDesktopBuild(desktopDirectory, readBuiltMain);
  return spawnProcess(electronPath, ["dist-electron/main.js"], {
    cwd: desktopDirectory,
    env: createSourceDesktopEnvironment({
      environment,
      homeDirectory,
      platform,
      readWindowsEnvironment,
    }),
    stdio: "inherit",
  });
}

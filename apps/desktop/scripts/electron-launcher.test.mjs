import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copyMacAppBundle } from "./electron-launcher.mjs";

describe("macOS Electron launcher copy", { skip: process.platform !== "darwin" }, () => {
  it("keeps framework symlink targets relative after relocation", (t) => {
    const root = mkdtempSync(join(tmpdir(), "synara-electron-launcher-"));
    const source = join(root, "source", "Electron.app");
    const target = join(root, "runtime", "Synara (Dev).app");
    const framework = join(source, "Contents", "Frameworks", "Electron Framework.framework");

    mkdirSync(join(framework, "Versions", "A", "Resources"), { recursive: true });
    writeFileSync(join(framework, "Versions", "A", "Resources", "icudtl.dat"), "icu");
    symlinkSync("A", join(framework, "Versions", "Current"));
    symlinkSync("Versions/Current/Resources", join(framework, "Resources"));

    copyMacAppBundle(source, target);
    rmSync(join(root, "source"), { recursive: true });

    const copiedResources = join(
      target,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Resources",
    );
    assert.equal(lstatSync(copiedResources).isSymbolicLink(), true);
    assert.equal(readlinkSync(copiedResources), "Versions/Current/Resources");
    assert.equal(readFileSync(join(copiedResources, "icudtl.dat"), "utf8"), "icu");
  });
});

// FILE: mac-after-sign.test.ts
// Purpose: Proves the afterSign hook actually strips the nested helper's entitlements.
// Layer: Release/build helper test
//
// This builds a real pair of ad-hoc signed bundles and asks `codesign` what
// they carry, rather than asserting on the arguments the hook would have
// passed. The bug it guards is not "we forgot to call codesign" — it is
// "codesign was called and the entitlements were still there", which only the
// real tool can answer. macOS-only for the obvious reason.

import { assert, describe, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { MAC_COMPUTER_HELPER_BUNDLE_PATH } from "./lib/desktop-platform-build-config.ts";

const require = createRequire(import.meta.url);
const { repairHelperEntitlements, verifyAppSignature } = require("./lib/mac-after-sign.cjs") as {
  verifyAppSignature: (appPath: string) => void;
  repairHelperEntitlements: (
    appPath: string,
    config: {
      readonly helperBundleRelativePath: string;
      readonly helperEntitlementsPath: string;
      readonly appEntitlementsPath: string;
    },
    projectDir: string,
    keychain: string | null,
  ) => boolean;
};

const INHERIT_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`;
const EMPTY_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
`;

function infoPlist(name: string, executable: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIdentifier</key><string>dev.synara.test.${name}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1.0</string>
</dict></plist>
`;
}

/** A minimal but genuine `.app`: real Mach-O executable, real Info.plist. */
function makeBundle(bundlePath: string, name: string): void {
  const executableName = name.toLowerCase().replaceAll(" ", "-");
  const macos = join(bundlePath, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  copyFileSync("/bin/echo", join(macos, executableName));
  chmodSync(join(macos, executableName), 0o755);
  writeFileSync(join(bundlePath, "Contents", "Info.plist"), infoPlist(name, executableName));
}

function codesign(args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function entitlementKeys(bundlePath: string): string[] {
  const { output } = codesign(["-d", "--entitlements", ":-", "--xml", bundlePath]);
  return [...output.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1] ?? "");
}

describe.skipIf(process.platform !== "darwin")("mac afterSign helper entitlement repair", () => {
  it("rejects an unsealed outer app even when the nested helper is valid", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-app-seal-"));
    try {
      const appPath = join(root, "Synara.app");
      makeBundle(appPath, "Synara");
      const helperPath = join(appPath, MAC_COMPUTER_HELPER_BUNDLE_PATH);
      makeBundle(helperPath, "Synara Computer Use");
      assert.equal(codesign(["--force", "--sign", "-", helperPath]).status, 0);
      assert.throws(() => verifyAppSignature(appPath));
      assert.equal(codesign(["--force", "--sign", "-", appPath]).status, 0);
      assert.doesNotThrow(() => verifyAppSignature(appPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips the inherited entitlements and leaves both signatures valid", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-after-sign-"));
    try {
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "inherit.plist"), INHERIT_ENTITLEMENTS);
      writeFileSync(join(projectDir, "empty.plist"), EMPTY_ENTITLEMENTS);

      const appPath = join(root, "Synara.app");
      makeBundle(appPath, "Synara");
      const helperPath = join(appPath, MAC_COMPUTER_HELPER_BUNDLE_PATH);
      makeBundle(helperPath, "Synara Computer Use");

      // Exactly what electron-builder does: nested code first, with the
      // inherited entitlements, then the outer app.
      assert.equal(
        codesign([
          "--force",
          "--sign",
          "-",
          "--entitlements",
          join(projectDir, "inherit.plist"),
          "--timestamp=none",
          helperPath,
        ]).status,
        0,
      );
      assert.equal(
        codesign([
          "--force",
          "--sign",
          "-",
          "--entitlements",
          join(projectDir, "inherit.plist"),
          "--timestamp=none",
          appPath,
        ]).status,
        0,
      );
      assert.deepStrictEqual(entitlementKeys(helperPath), [
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.disable-library-validation",
      ]);

      const repaired = repairHelperEntitlements(
        appPath,
        {
          helperBundleRelativePath: MAC_COMPUTER_HELPER_BUNDLE_PATH,
          helperEntitlementsPath: "empty.plist",
          appEntitlementsPath: "inherit.plist",
        },
        projectDir,
        null,
      );

      assert.equal(repaired, true);
      assert.deepStrictEqual(entitlementKeys(helperPath), []);
      // The outer app keeps its own entitlements — Electron's helpers need them.
      assert.deepStrictEqual(entitlementKeys(appPath), [
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.disable-library-validation",
      ]);
      // And the seal that records the helper's code directory hash was rebuilt:
      // without the re-seal this is exactly where a bare helper re-sign fails.
      assert.equal(codesign(["--verify", "--deep", "--strict", appPath]).status, 0);
      assert.equal(codesign(["--verify", "--strict", helperPath]).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: a helper with no entitlements is left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-after-sign-"));
    try {
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "inherit.plist"), INHERIT_ENTITLEMENTS);
      writeFileSync(join(projectDir, "empty.plist"), EMPTY_ENTITLEMENTS);

      const appPath = join(root, "Synara.app");
      makeBundle(appPath, "Synara");
      const helperPath = join(appPath, MAC_COMPUTER_HELPER_BUNDLE_PATH);
      makeBundle(helperPath, "Synara Computer Use");
      codesign(["--force", "--sign", "-", "--timestamp=none", helperPath]);
      codesign([
        "--force",
        "--sign",
        "-",
        "--entitlements",
        join(projectDir, "inherit.plist"),
        "--timestamp=none",
        appPath,
      ]);

      const repaired = repairHelperEntitlements(
        appPath,
        {
          helperBundleRelativePath: MAC_COMPUTER_HELPER_BUNDLE_PATH,
          helperEntitlementsPath: "empty.plist",
          appEntitlementsPath: "inherit.plist",
        },
        projectDir,
        null,
      );

      // Nothing to strip, so nothing is re-signed: a second pass over an
      // already-repaired app must not churn signatures (or, on a signed build,
      // spend a timestamp round trip) for no reason.
      assert.equal(repaired, false);
      assert.deepStrictEqual(entitlementKeys(helperPath), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an app whose helper bundle is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-after-sign-"));
    try {
      const appPath = join(root, "Synara.app");
      makeBundle(appPath, "Synara");
      assert.throws(
        () =>
          repairHelperEntitlements(
            appPath,
            {
              helperBundleRelativePath: MAC_COMPUTER_HELPER_BUNDLE_PATH,
              helperEntitlementsPath: "empty.plist",
              appEntitlementsPath: "app.plist",
            },
            root,
            null,
          ),
        /is missing Contents\/Helpers/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

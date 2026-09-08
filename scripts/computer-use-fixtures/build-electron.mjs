// Produces an isolated ad-hoc signed fixture, never the user's installed app.
import { cp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const destination = "/private/tmp/synara-cua-implementation/Synara Cua Fixture.app";
const resources = join(destination, "Contents/Resources");
await rm(destination, { recursive: true, force: true });
await cp(join(root, "apps/desktop/node_modules/electron/dist/Electron.app"), destination, {
  recursive: true,
  verbatimSymlinks: true,
});
await mkdir(join(resources, "app"), { recursive: true });
execFileSync(
  "bun",
  [
    "build",
    join(root, "apps/desktop/src/cuaFixtures/electron.ts"),
    "--target=node",
    "--format=cjs",
    "--external=electron",
    `--outfile=${join(resources, "app/fixture.cjs")}`,
  ],
  { stdio: "inherit", cwd: root },
);
await writeFile(
  join(resources, "app/package.json"),
  JSON.stringify({ name: "synara-cua-fixture", main: "fixture.cjs" }),
);
await cp(join(root, "apps/desktop/resources/cua-driver"), join(resources, "cua-driver"), {
  recursive: true,
});
if (process.env.SYNARA_CUA_FIXTURE_DRIVER) {
  await cp(process.env.SYNARA_CUA_FIXTURE_DRIVER, join(resources, "cua-driver/cua-driver"));
}
await writeFile(
  join(resources, "fixture-native.json"),
  JSON.stringify(
    {
      source: JSON.parse(
        await readFile(join(root, "packages/shared/src/cuaDriverRelease.json"), "utf8"),
      ),
      preSigningBinarySha256: createHash("sha256")
        .update(await readFile(join(resources, "cua-driver/cua-driver")))
        .digest("hex"),
      fixtureDriverOverride: !!process.env.SYNARA_CUA_FIXTURE_DRIVER,
    },
    null,
    2,
  ),
);
// This AppKit binary is only the test target. All input comes from Cua.
execFileSync(
  "/Library/Developer/CommandLineTools/usr/bin/swiftc",
  [
    "-sdk",
    "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk",
    "-module-cache-path",
    "/private/tmp/synara-cua-implementation/swift-module-cache",
    join(root, "scripts/computer-use-fixtures/NativeFixture.swift"),
    "-o",
    join(resources, "native-fixture"),
  ],
  { stdio: "inherit" },
);
const plist = join(destination, "Contents/Info.plist");
for (const [key, value] of Object.entries({
  CFBundleIdentifier: "com.synara.cua-fixture",
  CFBundleName: "Synara Cua Fixture",
  CFBundleDisplayName: "Synara Cua Fixture",
  NSAccessibilityUsageDescription: "Run input tests against this fixture's own windows.",
  NSScreenCaptureUsageDescription: "Capture this fixture's own windows for input tests.",
}))
  execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination], {
  stdio: "inherit",
});
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination], {
  stdio: "inherit",
});
console.log(destination);
